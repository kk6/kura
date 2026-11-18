use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};

use crate::library::{err, KURA_DIR};
use crate::manifest::{Aspect, Kind};
use crate::worker::{Pose, PoseStatus, Value};

const EMBEDDINGS: &str = "CREATE TABLE embeddings(
    hash TEXT NOT NULL,
    aspect TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY(hash, aspect, model)
);";

// status：0 人物なし、1 関節が足りない、2 ポーズあり。people は status が 2 のときだけ dim 個 × 人数
const POSES: &str = "CREATE TABLE poses(
    hash TEXT NOT NULL,
    aspect TEXT NOT NULL,
    model TEXT NOT NULL,
    status INTEGER NOT NULL,
    people BLOB NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY(hash, aspect, model)
);";

const TABLES: [&str; 2] = ["embeddings", "poses"];

fn status_code(s: PoseStatus) -> i64 {
    match s {
        PoseStatus::None => 0,
        PoseStatus::Few => 1,
        PoseStatus::Ok => 2,
    }
}

/// poses の1行を読む。決まりと違う行（知らない status、status と人数が合わない、長さが dim の倍数でない）は None
fn pose_row(status: i64, people: &[u8], dim: usize) -> Option<Pose> {
    let status = match status {
        0 => PoseStatus::None,
        1 => PoseStatus::Few,
        2 => PoseStatus::Ok,
        _ => return None,
    };
    let fits = match status {
        PoseStatus::Ok => !people.is_empty() && people.len().is_multiple_of(dim * 4),
        _ => people.is_empty(),
    };
    fits.then(|| Pose {
        status,
        people: floats(people).chunks(dim).map(<[f32]>::to_vec).collect(),
    })
}

/// 値が観点の形に合わなければ、その理由
fn misfit(a: &Aspect, v: &Value) -> Option<String> {
    match (a.kind, v) {
        (Kind::Vector, Value::Vector(v)) if v.len() != a.dim => Some(format!(
            "{} の特徴量の長さが {} です（{} のはず）",
            a.aspect,
            v.len(),
            a.dim
        )),
        (Kind::Vector, Value::Vector(_)) => None,
        (Kind::Pose, Value::Pose(p)) => {
            let ok = (p.status == PoseStatus::Ok) != p.people.is_empty()
                && p.people.iter().all(|x| x.len() == a.dim);
            (!ok).then(|| format!("{} のポーズの形が決まりと違います", a.aspect))
        }
        _ => Some(format!("{} の値の種類が違います", a.aspect)),
    }
}

/// 特徴量の DB。kura.db と別のファイルにし、消えても計算し直せるものだけを置く（5.6）
pub fn path(root: &Path) -> PathBuf {
    root.join(KURA_DIR).join("features.db")
}

pub struct Store {
    conn: Connection,
}

/// 開けなかった理由。作り直してよいか（SQLite でない、壊れている、版が違う）で分ける
enum Fault {
    Rebuild(String),
    Fail(String),
}

/// 開いた時点で中身が DB として読めないことを示すエラーか。I/O・ロック・権限のエラーでは作り直さない
fn fault(e: rusqlite::Error) -> Fault {
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => Fault::Rebuild(e.to_string()),
        _ => Fault::Fail(err(e)),
    }
}

fn bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn floats(b: &[u8]) -> Vec<f32> {
    b.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

impl Store {
    /// 開く。無ければ作る。SQLite でない・壊れている・版が違うときは、消して空で作り直す（1回だけ）。
    /// check は「疑って開く」で、quick_check で途中のページまで確かめる
    pub fn open(root: &Path, check: bool) -> Result<Store, String> {
        let file = path(root);
        let why = match Store::try_open(&file, check) {
            Ok(s) => return Ok(s),
            Err(Fault::Fail(e)) => return Err(e),
            Err(Fault::Rebuild(why)) => why,
        };
        log::warn!("features.db を作り直します（{}、{why}）", file.display());
        for suffix in ["", "-wal", "-shm"] {
            let mut name = file.clone().into_os_string();
            name.push(suffix);
            match fs::remove_file(&name) {
                Err(e) if e.kind() != ErrorKind::NotFound => {
                    return Err(format!(
                        "{} を消せません（{e}）",
                        Path::new(&name).display()
                    ))
                }
                _ => {}
            }
        }
        match Store::try_open(&file, check) {
            Ok(s) => Ok(s),
            Err(Fault::Fail(e) | Fault::Rebuild(e)) => Err(e),
        }
    }

    fn try_open(file: &Path, check: bool) -> Result<Store, Fault> {
        let mut conn = Connection::open(file).map_err(fault)?;
        // EXCLUSIVE：kura.db と同じく、外付けドライブが外れたときに共有メモリの mmap で落ちないため。
        // NORMAL：1枚ごとのコミットでディスクへの書き出しを待たない。失っても計算し直せる
        conn.execute_batch(
            "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
        )
        .map_err(fault)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(fault)?;
        // 版1（3a）からは poses を足すだけにし、embeddings の行を残す。内容と構図を計算し直さないため
        let create = match version {
            0 => format!("{EMBEDDINGS}{POSES}"),
            1 => POSES.to_string(),
            2 => String::new(),
            v => return Err(Fault::Rebuild(format!("版が {v} です"))),
        };
        if !create.is_empty() {
            let tx = conn.transaction().map_err(fault)?;
            tx.execute_batch(&format!("{create}PRAGMA user_version = 2;"))
                .map_err(fault)?;
            tx.commit().map_err(fault)?;
        }
        if check {
            let result: Vec<String> = conn
                .prepare("PRAGMA quick_check")
                .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
                .map_err(fault)?;
            if result != ["ok"] {
                return Err(Fault::Rebuild(result.join("、")));
            }
        }
        Ok(Store { conn })
    }

    /// 1枚分を1つのトランザクションで書く。同じキーの行は置き換える。Vector は embeddings に、Pose は poses に書く。
    /// 形が観点と合わない値（長さ、status と人数）があれば、何も書かずに Err
    pub fn put(
        &mut self,
        hash: &str,
        values: &[(&Aspect, &Value)],
        now: i64,
    ) -> Result<(), String> {
        if let Some(why) = values.iter().find_map(|(a, v)| misfit(a, v)) {
            return Err(why);
        }
        let tx = self.conn.transaction().map_err(err)?;
        for (a, v) in values {
            match v {
                Value::Vector(v) => tx.execute(
                    "INSERT OR REPLACE INTO embeddings VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![hash, a.aspect, a.model, bytes(v), now],
                ),
                Value::Pose(p) => tx.execute(
                    "INSERT OR REPLACE INTO poses VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        hash,
                        a.aspect,
                        a.model,
                        status_code(p.status),
                        bytes(&p.people.concat()),
                        now
                    ],
                ),
            }
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// 観点ごとの、今のモデル名の正しい形の行がある画像のハッシュ。返り値は aspects と同じ順
    pub fn computed(&self, aspects: &[Aspect]) -> Result<Vec<HashSet<String>>, String> {
        // 2万件のハッシュを IN に並べると変数の上限に近づくので、全部を読んで突き合わせる
        let mut out = vec![HashSet::new(); aspects.len()];
        let index = |aspect: &str, model: &str| {
            aspects
                .iter()
                .position(|a| a.aspect == aspect && a.model == model)
        };
        let mut stmt = self
            .conn
            .prepare("SELECT hash, aspect, model, length(vector) FROM embeddings")
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(r) = rows.next().map_err(err)? {
            let (aspect, model, len): (String, String, i64) = (
                r.get(1).map_err(err)?,
                r.get(2).map_err(err)?,
                r.get(3).map_err(err)?,
            );
            if let Some(i) = index(&aspect, &model) {
                let a = &aspects[i];
                if a.kind == Kind::Vector && (a.dim * 4) as i64 == len {
                    out[i].insert(r.get(0).map_err(err)?);
                }
            }
        }
        let mut stmt = self
            .conn
            .prepare("SELECT hash, aspect, model, status, people FROM poses")
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(r) = rows.next().map_err(err)? {
            let (aspect, model): (String, String) =
                (r.get(1).map_err(err)?, r.get(2).map_err(err)?);
            if let Some(i) = index(&aspect, &model) {
                let a = &aspects[i];
                let people: Vec<u8> = r.get(4).map_err(err)?;
                if a.kind == Kind::Pose
                    && pose_row(r.get(3).map_err(err)?, &people, a.dim).is_some()
                {
                    out[i].insert(r.get(0).map_err(err)?);
                }
            }
        }
        Ok(out)
    }

    /// hash の画像に、aspects のすべてについて今のモデル名の行があるか。computed の1枚分
    pub fn has(&self, hash: &str, aspects: &[Aspect]) -> Result<bool, String> {
        for a in aspects {
            let found = match a.kind {
                Kind::Vector => self
                    .conn
                    .prepare_cached("SELECT 1 FROM embeddings WHERE hash = ?1 AND aspect = ?2 AND model = ?3 AND length(vector) = ?4")
                    .and_then(|mut s| s.exists(params![hash, a.aspect, a.model, (a.dim * 4) as i64])),
                Kind::Pose => self
                    .conn
                    .query_row(
                        "SELECT status, people FROM poses WHERE hash = ?1 AND aspect = ?2 AND model = ?3",
                        params![hash, a.aspect, a.model],
                        |r| Ok(pose_row(r.get(0)?, &r.get::<_, Vec<u8>>(1)?, a.dim).is_some()),
                    )
                    .optional()
                    .map(|f| f == Some(true)),
            }
            .map_err(err)?;
            if !found {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// vector の観点の、今のモデル名の行をすべて読む。pose の観点は Err
    pub fn load(&self, aspect: &Aspect) -> Result<Vec<(String, Vec<f32>)>, String> {
        if aspect.kind != Kind::Vector {
            return Err(format!("{} はベクトルの観点ではありません", aspect.aspect));
        }
        let mut stmt = self
            .conn
            .prepare("SELECT hash, vector FROM embeddings WHERE aspect = ?1 AND model = ?2")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![aspect.aspect, aspect.model], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (hash, blob) = row.map_err(err)?;
            if blob.len() == aspect.dim * 4 {
                out.push((hash, floats(&blob)));
            }
        }
        Ok(out)
    }

    /// pose の観点の、今のモデル名の正しい形の行をすべて読む
    pub fn load_poses(&self, aspect: &Aspect) -> Result<Vec<(String, Pose)>, String> {
        if aspect.kind != Kind::Pose {
            return Err(format!("{} はポーズの観点ではありません", aspect.aspect));
        }
        let mut stmt = self
            .conn
            .prepare("SELECT hash, status, people FROM poses WHERE aspect = ?1 AND model = ?2")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![aspect.aspect, aspect.model], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (hash, status, people) = row.map_err(err)?;
            if let Some(p) = pose_row(status, &people, aspect.dim) {
                out.push((hash, p));
            }
        }
        Ok(out)
    }

    /// その画像の行を、観点とモデル名によらずすべて消す
    pub fn remove(&mut self, hash: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(err)?;
        for t in TABLES {
            tx.execute(&format!("DELETE FROM {t} WHERE hash = ?1"), [hash])
                .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// keep にないハッシュの行と、aspects にない（観点, モデル名）の行を消す。消した行の数を返す
    pub fn sweep(&mut self, keep: &HashSet<String>, aspects: &[Aspect]) -> Result<usize, String> {
        let mut gone = Vec::new();
        for t in TABLES {
            let mut stmt = self
                .conn
                .prepare(&format!("SELECT rowid, hash, aspect, model FROM {t}"))
                .map_err(err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(err)?;
            for row in rows {
                let (id, hash, aspect, model) = row.map_err(err)?;
                if !keep.contains(&hash)
                    || !aspects
                        .iter()
                        .any(|a| a.aspect == aspect && a.model == model)
                {
                    gone.push((t, id));
                }
            }
        }
        let tx = self.conn.transaction().map_err(err)?;
        for (t, id) in &gone {
            tx.execute(&format!("DELETE FROM {t} WHERE rowid = ?1"), [id])
                .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(gone.len())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use rusqlite::ErrorCode;

    use super::*;

    pub(crate) fn aspect(name: &str, model: &str, dim: usize) -> Aspect {
        Aspect {
            aspect: name.into(),
            model: model.into(),
            kind: Kind::Vector,
            dim,
            files: vec![],
        }
    }

    pub(crate) fn pose_aspect(model: &str, dim: usize) -> Aspect {
        Aspect {
            kind: Kind::Pose,
            ..aspect("pose", model, dim)
        }
    }

    pub(crate) fn pose(status: PoseStatus, people: &[&[f32]]) -> Value {
        Value::Pose(Pose {
            status,
            people: people.iter().map(|p| p.to_vec()).collect(),
        })
    }

    impl Store {
        /// ベクトルの観点だけを書く put
        pub(crate) fn put_vectors(
            &mut self,
            hash: &str,
            vectors: &[(&Aspect, &[f32])],
            now: i64,
        ) -> Result<(), String> {
            let values: Vec<Value> = vectors
                .iter()
                .map(|(_, v)| Value::Vector(v.to_vec()))
                .collect();
            let pairs: Vec<(&Aspect, &Value)> =
                vectors.iter().map(|(a, _)| *a).zip(&values).collect();
            self.put(hash, &pairs, now)
        }

        /// embeddings の（ハッシュ, 観点, computed_at）
        pub(crate) fn embedding_times(&self) -> Result<Vec<(String, String, i64)>, String> {
            self.conn
                .prepare("SELECT hash, aspect, computed_at FROM embeddings ORDER BY hash, aspect")
                .and_then(|mut s| {
                    s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                        .collect()
                })
                .map_err(err)
        }

        /// aspects のすべてがそろった画像のハッシュ
        pub(crate) fn computed_all(&self, aspects: &[Aspect]) -> Result<HashSet<String>, String> {
            let mut sets = self.computed(aspects)?.into_iter();
            let first = sets.next().unwrap_or_default();
            Ok(sets.fold(first, |acc, s| &acc & &s))
        }
    }

    /// ライブラリの features.db に、hashes の画像の特徴量を1つずつ書く
    pub(crate) fn seed(lib: &mut crate::library::Library, hashes: &[&str]) {
        let c = content();
        for h in hashes {
            lib.with_features(|s| s.put_vectors(h, &[(&c, &[1.0; 4])], 1))
                .unwrap();
        }
    }

    /// ライブラリの features.db に特徴量がある画像のハッシュ
    pub(crate) fn stored(lib: &mut crate::library::Library) -> HashSet<String> {
        lib.with_features(|s| s.computed_all(&[content()])).unwrap()
    }

    fn content() -> Aspect {
        aspect("content", "m1", 4)
    }

    fn composition() -> Aspect {
        aspect("composition", "c1", 3)
    }

    fn root() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join(KURA_DIR)).unwrap();
        d
    }

    fn set<const N: usize>(hashes: [&str; N]) -> HashSet<String> {
        hashes.iter().map(|h| h.to_string()).collect()
    }

    /// 1ページ（4096バイト）に数行しか入らない大きさのベクトルを n 枚分書く。途中のページを壊すテストに使う
    pub(crate) fn fill(store: &mut Store, n: usize) -> Aspect {
        let big = aspect("content", "big", 256);
        for i in 0..n {
            let v = vec![i as f32; 256];
            store
                .put_vectors(&format!("h{i}"), &[(&big, &v)], 1)
                .unwrap();
        }
        big
    }

    /// WAL を本体に入れた後の DB の、3ページ目より後ろを上書きする。1ページ目の見出しと user_version は残る
    pub(crate) fn corrupt(file: &Path) -> Vec<u8> {
        let mut bytes = fs::read(file).unwrap();
        assert!(bytes.len() > 4 * 4096, "壊すページが足りません");
        for b in &mut bytes[3 * 4096..] {
            *b = 0x55;
        }
        fs::write(file, &bytes).unwrap();
        bytes
    }

    fn tables(s: &Store) -> Vec<String> {
        s.conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn user_version(s: &Store) -> i64 {
        s.conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn 無いところに開くとfeatures_dbができ版が2で両方の表がある() {
        let d = root();

        let s = Store::open(d.path(), false).unwrap();

        assert!(path(d.path()).is_file());
        assert_eq!(user_version(&s), 2);
        assert_eq!(tables(&s), ["embeddings", "poses"]);
    }

    #[test]
    fn 書いたベクトルをfloat32のまま同じ値で読める() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k) = (content(), composition());
        let v = [0.1f32, -2.5, f32::MIN_POSITIVE, 1e30];

        s.put_vectors("a", &[(&c, &v), (&k, &[1.0, 2.0, 3.0])], 5)
            .unwrap();

        assert_eq!(s.load(&c).unwrap(), [("a".to_string(), v.to_vec())]);
        assert_eq!(
            s.load(&k).unwrap(),
            [("a".to_string(), vec![1.0, 2.0, 3.0])]
        );
    }

    #[test]
    fn 同じ画像と観点とモデル名で書き直すと置き換わる() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let c = content();
        s.put_vectors("a", &[(&c, &[1.0; 4])], 1).unwrap();

        s.put_vectors("a", &[(&c, &[2.0; 4])], 2).unwrap();

        assert_eq!(s.load(&c).unwrap(), [("a".to_string(), vec![2.0; 4])]);
    }

    #[test]
    fn 計算済みはすべての観点がそろった画像だけ() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k) = (content(), composition());
        s.put_vectors("both", &[(&c, &[1.0; 4]), (&k, &[1.0; 3])], 1)
            .unwrap();
        s.put_vectors("half", &[(&c, &[1.0; 4])], 1).unwrap();

        assert_eq!(s.computed_all(&[c, k]).unwrap(), set(["both"]));
    }

    #[test]
    fn モデル名の違う行は計算済みにも読み出しにも数えない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let old = aspect("content", "m0", 4);
        s.put_vectors("a", &[(&old, &[1.0; 4])], 1).unwrap();
        s.put_vectors("b", &[(&content(), &[2.0; 4])], 1).unwrap();

        assert_eq!(s.computed_all(&[content()]).unwrap(), set(["b"]));
        assert_eq!(
            s.load(&content()).unwrap(),
            [("b".to_string(), vec![2.0; 4])]
        );
    }

    #[test]
    fn 画像を消すと観点とモデル名によらずその画像の行だけが消える() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k, old) = (content(), composition(), aspect("content", "m0", 4));
        s.put_vectors("a", &[(&c, &[1.0; 4]), (&k, &[1.0; 3])], 1)
            .unwrap();
        s.put_vectors("a", &[(&old, &[1.0; 4])], 1).unwrap();
        s.put_vectors("b", &[(&c, &[2.0; 4])], 1).unwrap();

        s.remove("a").unwrap();

        assert_eq!(s.load(&c).unwrap(), [("b".to_string(), vec![2.0; 4])]);
        assert!(s.load(&k).unwrap().is_empty());
        assert!(s.load(&old).unwrap().is_empty());
    }

    #[test]
    fn 掃除は残す画像にない行と今のモデル名でない行を消し残りは変えない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k, old) = (content(), composition(), aspect("content", "m0", 4));
        s.put_vectors("keep", &[(&c, &[1.0; 4]), (&k, &[1.0; 3])], 1)
            .unwrap();
        s.put_vectors("keep", &[(&old, &[1.0; 4])], 1).unwrap();
        s.put_vectors("gone", &[(&c, &[2.0; 4])], 1).unwrap();

        let n = s.sweep(&set(["keep"]), &[c.clone(), k.clone()]).unwrap();

        assert_eq!(n, 2);
        assert_eq!(s.load(&c).unwrap(), [("keep".to_string(), vec![1.0; 4])]);
        assert_eq!(s.load(&k).unwrap(), [("keep".to_string(), vec![1.0; 3])]);
        assert!(s.load(&old).unwrap().is_empty());
    }

    #[test]
    fn sqliteでないファイルは空で作り直す() {
        let d = root();
        fs::write(path(d.path()), "これは DB ではない".repeat(500)).unwrap();

        let s = Store::open(d.path(), false).unwrap();

        assert!(s.computed_all(&[content()]).unwrap().is_empty());
        assert_eq!(user_version(&s), 2);
    }

    #[test]
    fn 版が3以上のファイルは空で作り直す() {
        for version in [3, 99] {
            let d = root();
            let mut s = Store::open(d.path(), false).unwrap();
            s.put_vectors("a", &[(&content(), &[1.0; 4])], 1).unwrap();
            drop(s);
            Connection::open(path(d.path()))
                .unwrap()
                .pragma_update(None, "user_version", version)
                .unwrap();

            let s = Store::open(d.path(), false).unwrap();

            assert!(s.load(&content()).unwrap().is_empty(), "{version}");
            assert_eq!(user_version(&s), 2, "{version}");
        }
    }

    #[test]
    fn walとshmが残っていても作り直した後は空になる() {
        let d = root();
        let file = path(d.path());
        fs::write(&file, "壊れた本体".repeat(500)).unwrap();
        let wal = file.with_file_name("features.db-wal");
        let shm = file.with_file_name("features.db-shm");
        fs::write(&wal, "残った WAL".repeat(500)).unwrap();
        fs::write(&shm, "残った共有メモリ".repeat(500)).unwrap();

        let mut s = Store::open(d.path(), false).unwrap();

        assert!(s.computed_all(&[content()]).unwrap().is_empty());
        s.put_vectors("a", &[(&content(), &[1.0; 4])], 1).unwrap();
        assert_eq!(s.computed_all(&[content()]).unwrap(), set(["a"]));
        assert!(!shm.exists());
        assert!(!fs::read(&wal).unwrap().starts_with("残った WAL".as_bytes()));
    }

    #[test]
    fn 読めないファイルはエラーにしてファイルも行も残す() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        s.put_vectors("a", &[(&content(), &[1.0; 4])], 1).unwrap();
        drop(s);
        let file = path(d.path());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();

        let r = Store::open(d.path(), false);
        let code = Connection::open(&file)
            .and_then(|c| c.execute_batch("PRAGMA user_version"))
            .err()
            .and_then(|e| e.sqlite_error_code());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        assert!(r.is_err());
        assert!(code.is_some(), "読めないファイルを開けてしまいました");
        assert!(!matches!(
            code,
            Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
        ));
        let s = Store::open(d.path(), false).unwrap();
        assert_eq!(s.computed_all(&[content()]).unwrap(), set(["a"]));
    }

    #[test]
    fn 確かめて開くと途中のページが壊れたファイルを作り直し確かめなければ作り直さない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let big = fill(&mut s, 40);
        drop(s);
        let file = path(d.path());
        let broken = corrupt(&file);

        drop(Store::open(d.path(), false).unwrap());
        assert_eq!(fs::read(&file).unwrap(), broken);

        let s = Store::open(d.path(), true).unwrap();
        assert!(s.load(&big).unwrap().is_empty());
        assert_eq!(user_version(&s), 2);
    }

    #[test]
    fn 確かめて開いても壊れていないファイルの行は残る() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let big = fill(&mut s, 40);
        drop(s);

        let s = Store::open(d.path(), true).unwrap();

        assert_eq!(s.load(&big).unwrap().len(), 40);
    }

    #[test]
    fn 長さが次元と違うベクトルはエラーにしてほかの観点も書かない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k) = (content(), composition());

        let r = s.put_vectors("a", &[(&c, &[1.0; 4]), (&k, &[1.0; 2])], 1);

        assert!(r.is_err());
        assert!(s.load(&c).unwrap().is_empty());
        assert!(s.computed_all(&[c]).unwrap().is_empty());
    }

    #[test]
    fn ベクトルの長さが違う行は計算済みにも読み出しにも数えない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let c = content();
        s.put_vectors("good", &[(&c, &[1.0; 4])], 1).unwrap();
        s.conn
            .execute(
                "INSERT INTO embeddings VALUES ('short', 'content', 'm1', ?1, 1)",
                [vec![0u8; 12]],
            )
            .unwrap();

        assert_eq!(
            s.computed_all(std::slice::from_ref(&c)).unwrap(),
            set(["good"])
        );
        assert_eq!(s.load(&c).unwrap().len(), 1);
    }

    fn person(x: f32) -> Vec<f32> {
        vec![x; 3]
    }

    #[test]
    fn 版1のファイルを開くと版2になりembeddingsの行が残る() {
        let d = root();
        // 3a のアプリが作る版1の features.db
        let conn = Connection::open(path(d.path())).unwrap();
        conn.execute_batch(EMBEDDINGS).unwrap();
        conn.execute(
            "INSERT INTO embeddings VALUES ('a', 'content', 'm1', ?1, 7)",
            [bytes(&[1.0; 4])],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        drop(conn);

        let s = Store::open(d.path(), false).unwrap();

        assert_eq!(user_version(&s), 2);
        assert_eq!(tables(&s), ["embeddings", "poses"]);
        assert_eq!(
            s.load(&content()).unwrap(),
            [("a".to_string(), vec![1.0; 4])]
        );
        let at: i64 = s
            .conn
            .query_row("SELECT computed_at FROM embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(at, 7);
        drop(s);
        // 開き直しても版2のまま、行も残る
        let s = Store::open(d.path(), false).unwrap();
        assert_eq!(s.computed_all(&[content()]).unwrap(), set(["a"]));
    }

    #[test]
    fn ポーズの3つの状態を書けて読めてどれも計算済みに入る() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let p = pose_aspect("p1", 3);
        let ok = pose(PoseStatus::Ok, &[&person(0.5), &person(-1.0)]);
        s.put("ok", &[(&p, &ok)], 1).unwrap();
        s.put("none", &[(&p, &pose(PoseStatus::None, &[]))], 1)
            .unwrap();
        s.put("few", &[(&p, &pose(PoseStatus::Few, &[]))], 1)
            .unwrap();

        let mut got = s.load_poses(&p).unwrap();
        got.sort_by(|a, b| a.0.cmp(&b.0));
        let want: Vec<(String, Value)> = vec![
            ("few".into(), pose(PoseStatus::Few, &[])),
            ("none".into(), pose(PoseStatus::None, &[])),
            ("ok".into(), ok),
        ];
        let got: Vec<(String, Value)> = got.into_iter().map(|(h, p)| (h, Value::Pose(p))).collect();
        assert_eq!(got, want);
        assert_eq!(
            s.computed(&[p.clone()]).unwrap(),
            [set(["ok", "none", "few"])]
        );
        assert!(s.has("none", &[p.clone()]).unwrap());
        assert!(!s.has("other", &[p]).unwrap());
    }

    #[test]
    fn 計算済みは観点ごとにaspectsと同じ順で返る() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k, p) = (content(), composition(), pose_aspect("p1", 3));
        s.put_vectors("both", &[(&c, &[1.0; 4]), (&k, &[1.0; 3])], 1)
            .unwrap();
        s.put("pose", &[(&p, &pose(PoseStatus::None, &[]))], 1)
            .unwrap();

        assert_eq!(
            s.computed(&[p.clone(), c.clone(), k.clone()]).unwrap(),
            [set(["pose"]), set(["both"]), set(["both"])]
        );
        // 同じ名前でも種類の違う観点として渡した行は数えない
        let wrong = aspect("pose", "p1", 3);
        assert_eq!(s.computed(&[wrong]).unwrap(), [set([])]);
    }

    #[test]
    fn 形の合わないポーズはエラーにして同じ呼び出しのほかの観点も書かない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, p) = (content(), pose_aspect("p1", 3));
        let wrong = [
            pose(PoseStatus::Ok, &[]),
            pose(PoseStatus::None, &[&person(1.0)]),
            pose(PoseStatus::Few, &[&person(1.0)]),
            pose(PoseStatus::Ok, &[&[1.0, 2.0]]),
            pose(PoseStatus::Ok, &[&person(1.0), &[1.0; 4]]),
            Value::Vector(vec![1.0; 3]),
        ];
        let v = Value::Vector(vec![1.0; 4]);
        for w in &wrong {
            assert!(s.put("a", &[(&c, &v), (&p, w)], 1).is_err(), "{w:?}");
        }
        // vector の観点に pose の値
        assert!(s
            .put("a", &[(&c, &pose(PoseStatus::None, &[]))], 1)
            .is_err());

        assert!(s.load(&c).unwrap().is_empty());
        assert!(s.load_poses(&p).unwrap().is_empty());
    }

    #[test]
    fn 壊れたポーズの行は計算済みにも読み出しにも数えない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let p = pose_aspect("p1", 3);
        s.put("good", &[(&p, &pose(PoseStatus::Few, &[]))], 1)
            .unwrap();
        let broken: [(&str, i64, Vec<u8>); 4] = [
            ("unknown", 3, vec![]),
            ("ok-empty", 2, vec![]),
            ("ok-short", 2, bytes(&[1.0; 4])),
            ("none-people", 0, bytes(&[1.0; 3])),
        ];
        for (h, status, people) in broken {
            s.conn
                .execute(
                    "INSERT INTO poses VALUES (?1, 'pose', 'p1', ?2, ?3, 1)",
                    params![h, status, people],
                )
                .unwrap();
        }

        assert_eq!(s.computed(&[p.clone()]).unwrap(), [set(["good"])]);
        assert_eq!(s.load_poses(&p).unwrap().len(), 1);
        assert!(!s.has("ok-short", &[p]).unwrap());
    }

    #[test]
    fn 種類の違う観点の読み出しはエラーにする() {
        let d = root();
        let s = Store::open(d.path(), false).unwrap();
        assert!(s.load(&pose_aspect("p1", 3)).is_err());
        assert!(s.load_poses(&content()).is_err());
    }

    #[test]
    fn 消すと掃除はポーズの行も見る() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (p, old) = (pose_aspect("p1", 3), pose_aspect("p0", 3));
        let none = pose(PoseStatus::None, &[]);
        for h in ["keep", "gone", "removed"] {
            s.put(h, &[(&p, &none)], 1).unwrap();
        }
        s.put("keep", &[(&old, &none)], 1).unwrap();

        s.remove("removed").unwrap();
        let n = s
            .sweep(&set(["keep", "removed"]), &[content(), p.clone()])
            .unwrap();

        assert_eq!(n, 2);
        assert_eq!(
            s.computed(&[p.clone(), old.clone()]).unwrap(),
            [set(["keep"]), set([])]
        );
    }
}
