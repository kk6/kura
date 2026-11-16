use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, ErrorCode};

use crate::library::{err, KURA_DIR};
use crate::manifest::Aspect;

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
        match version {
            0 => {
                let tx = conn.transaction().map_err(fault)?;
                tx.execute_batch(
                    "CREATE TABLE embeddings(
                        hash TEXT NOT NULL,
                        aspect TEXT NOT NULL,
                        model TEXT NOT NULL,
                        vector BLOB NOT NULL,
                        computed_at INTEGER NOT NULL,
                        PRIMARY KEY(hash, aspect, model)
                    );
                    PRAGMA user_version = 1;",
                )
                .map_err(fault)?;
                tx.commit().map_err(fault)?;
            }
            1 => {}
            v => return Err(Fault::Rebuild(format!("版が {v} です"))),
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

    /// 1枚分を1つのトランザクションで書く。同じキーの行は置き換える。長さが dim と違うベクトルは、何も書かずに Err
    pub fn put(
        &mut self,
        hash: &str,
        vectors: &[(&Aspect, &[f32])],
        now: i64,
    ) -> Result<(), String> {
        if let Some((a, v)) = vectors.iter().find(|(a, v)| v.len() != a.dim) {
            return Err(format!(
                "{} の特徴量の長さが {} です（{} のはず）",
                a.aspect,
                v.len(),
                a.dim
            ));
        }
        let tx = self.conn.transaction().map_err(err)?;
        for (a, v) in vectors {
            tx.execute(
                "INSERT OR REPLACE INTO embeddings VALUES (?1, ?2, ?3, ?4, ?5)",
                params![hash, a.aspect, a.model, bytes(v), now],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// aspects のすべてについて、今のモデル名の行がある画像のハッシュ
    pub fn computed(&self, aspects: &[Aspect]) -> Result<HashSet<String>, String> {
        // 2万件のハッシュを IN に並べると変数の上限に近づくので、全部を読んで突き合わせる
        let mut stmt = self
            .conn
            .prepare("SELECT hash, aspect, model, length(vector) FROM embeddings")
            .map_err(err)?;
        let mut found: HashMap<String, usize> = HashMap::new();
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(r) = rows.next().map_err(err)? {
            let (aspect, model, len): (String, String, i64) = (
                r.get(1).map_err(err)?,
                r.get(2).map_err(err)?,
                r.get(3).map_err(err)?,
            );
            if aspects
                .iter()
                .any(|a| a.aspect == aspect && a.model == model && (a.dim * 4) as i64 == len)
            {
                *found.entry(r.get(0).map_err(err)?).or_default() += 1;
            }
        }
        Ok(found
            .into_iter()
            .filter(|(_, n)| *n == aspects.len())
            .map(|(h, _)| h)
            .collect())
    }

    /// 1つの観点の、今のモデル名の行をすべて読む
    pub fn load(&self, aspect: &Aspect) -> Result<Vec<(String, Vec<f32>)>, String> {
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

    /// その画像の行を、観点とモデル名によらずすべて消す
    pub fn remove(&mut self, hash: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM embeddings WHERE hash = ?1", [hash])
            .map(|_| ())
            .map_err(err)
    }

    /// keep にないハッシュの行と、aspects にない（観点, モデル名）の行を消す。消した行の数を返す
    pub fn sweep(&mut self, keep: &HashSet<String>, aspects: &[Aspect]) -> Result<usize, String> {
        let gone = {
            let mut stmt = self
                .conn
                .prepare("SELECT rowid, hash, aspect, model FROM embeddings")
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
            let mut gone = Vec::new();
            for row in rows {
                let (id, hash, aspect, model) = row.map_err(err)?;
                if !keep.contains(&hash)
                    || !aspects
                        .iter()
                        .any(|a| a.aspect == aspect && a.model == model)
                {
                    gone.push(id);
                }
            }
            gone
        };
        let tx = self.conn.transaction().map_err(err)?;
        for id in &gone {
            tx.execute("DELETE FROM embeddings WHERE rowid = ?1", [id])
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
            dim,
            file: None,
        }
    }

    /// ライブラリの features.db に、hashes の画像の特徴量を1つずつ書く
    pub(crate) fn seed(lib: &mut crate::library::Library, hashes: &[&str]) {
        let c = content();
        for h in hashes {
            lib.with_features(|s| s.put(h, &[(&c, &[1.0; 4])], 1))
                .unwrap();
        }
    }

    /// ライブラリの features.db に特徴量がある画像のハッシュ
    pub(crate) fn stored(lib: &mut crate::library::Library) -> HashSet<String> {
        lib.with_features(|s| s.computed(&[content()])).unwrap()
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
            store.put(&format!("h{i}"), &[(&big, &v)], 1).unwrap();
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

    fn user_version(s: &Store) -> i64 {
        s.conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn 無いところに開くとfeatures_dbができ版が1になる() {
        let d = root();

        let s = Store::open(d.path(), false).unwrap();

        assert!(path(d.path()).is_file());
        assert_eq!(user_version(&s), 1);
    }

    #[test]
    fn 書いたベクトルをfloat32のまま同じ値で読める() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k) = (content(), composition());
        let v = [0.1f32, -2.5, f32::MIN_POSITIVE, 1e30];

        s.put("a", &[(&c, &v), (&k, &[1.0, 2.0, 3.0])], 5).unwrap();

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
        s.put("a", &[(&c, &[1.0; 4])], 1).unwrap();

        s.put("a", &[(&c, &[2.0; 4])], 2).unwrap();

        assert_eq!(s.load(&c).unwrap(), [("a".to_string(), vec![2.0; 4])]);
    }

    #[test]
    fn 計算済みはすべての観点がそろった画像だけ() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let (c, k) = (content(), composition());
        s.put("both", &[(&c, &[1.0; 4]), (&k, &[1.0; 3])], 1)
            .unwrap();
        s.put("half", &[(&c, &[1.0; 4])], 1).unwrap();

        assert_eq!(s.computed(&[c, k]).unwrap(), set(["both"]));
    }

    #[test]
    fn モデル名の違う行は計算済みにも読み出しにも数えない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let old = aspect("content", "m0", 4);
        s.put("a", &[(&old, &[1.0; 4])], 1).unwrap();
        s.put("b", &[(&content(), &[2.0; 4])], 1).unwrap();

        assert_eq!(s.computed(&[content()]).unwrap(), set(["b"]));
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
        s.put("a", &[(&c, &[1.0; 4]), (&k, &[1.0; 3])], 1).unwrap();
        s.put("a", &[(&old, &[1.0; 4])], 1).unwrap();
        s.put("b", &[(&c, &[2.0; 4])], 1).unwrap();

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
        s.put("keep", &[(&c, &[1.0; 4]), (&k, &[1.0; 3])], 1)
            .unwrap();
        s.put("keep", &[(&old, &[1.0; 4])], 1).unwrap();
        s.put("gone", &[(&c, &[2.0; 4])], 1).unwrap();

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

        assert!(s.computed(&[content()]).unwrap().is_empty());
        assert_eq!(user_version(&s), 1);
    }

    #[test]
    fn 版が1でも0でもないファイルは空で作り直す() {
        for version in [2, 99] {
            let d = root();
            let mut s = Store::open(d.path(), false).unwrap();
            s.put("a", &[(&content(), &[1.0; 4])], 1).unwrap();
            drop(s);
            Connection::open(path(d.path()))
                .unwrap()
                .pragma_update(None, "user_version", version)
                .unwrap();

            let s = Store::open(d.path(), false).unwrap();

            assert!(s.load(&content()).unwrap().is_empty(), "{version}");
            assert_eq!(user_version(&s), 1, "{version}");
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

        assert!(s.computed(&[content()]).unwrap().is_empty());
        s.put("a", &[(&content(), &[1.0; 4])], 1).unwrap();
        assert_eq!(s.computed(&[content()]).unwrap(), set(["a"]));
        assert!(!shm.exists());
        assert!(!fs::read(&wal).unwrap().starts_with("残った WAL".as_bytes()));
    }

    #[test]
    fn 読めないファイルはエラーにしてファイルも行も残す() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        s.put("a", &[(&content(), &[1.0; 4])], 1).unwrap();
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
        assert_eq!(s.computed(&[content()]).unwrap(), set(["a"]));
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
        assert_eq!(user_version(&s), 1);
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

        let r = s.put("a", &[(&c, &[1.0; 4]), (&k, &[1.0; 2])], 1);

        assert!(r.is_err());
        assert!(s.load(&c).unwrap().is_empty());
        assert!(s.computed(&[c]).unwrap().is_empty());
    }

    #[test]
    fn ベクトルの長さが違う行は計算済みにも読み出しにも数えない() {
        let d = root();
        let mut s = Store::open(d.path(), false).unwrap();
        let c = content();
        s.put("good", &[(&c, &[1.0; 4])], 1).unwrap();
        s.conn
            .execute(
                "INSERT INTO embeddings VALUES ('short', 'content', 'm1', ?1, 1)",
                [vec![0u8; 12]],
            )
            .unwrap();

        assert_eq!(s.computed(std::slice::from_ref(&c)).unwrap(), set(["good"]));
        assert_eq!(s.load(&c).unwrap().len(), 1);
    }
}
