use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rusqlite::Transaction;

use crate::category;
use crate::fileops::{self, OnConflict, PendingOp, Request};
use crate::import::{self, Reason, Skipped};
use crate::library::{err, Library, DUPLICATES_DIR, UNSUPPORTED_DIR};

/// 対応していない形式のファイルを `_未対応ファイル/` へ移す操作（FR-108）の、pending_ops の種類
pub const SET_ASIDE: &str = "set_aside";
/// 重複として登録しなかったファイルを `.kura/trash/.duplicates/` へ移す操作（FR-109）の、pending_ops の種類
pub const TRASH_DUPLICATE: &str = "trash_duplicate";

/// SET_ASIDE と TRASH_DUPLICATE の DB の更新。どちらも DB に行のないファイルを動かすだけなので、何も変えない
pub fn apply_none(_: &Transaction, _: &PendingOp) -> Result<(), String> {
    Ok(())
}

/// skipped のうち対応していない形式のファイルを `_未対応ファイル/` へ移し、理由を移した先に書き換える（FR-108）。
/// 移せなかったファイルはその理由のエラーにする。同名があれば連番を付ける
pub fn set_aside(lib: &mut Library, skipped: &mut [Skipped]) {
    let dir = Path::new(UNSUPPORTED_DIR);
    for s in skipped.iter_mut() {
        if s.reason != Reason::Unsupported {
            continue;
        }
        let result = movable(lib, &s.path).and_then(|rel| {
            fs::create_dir_all(lib.root.join(dir))
                .map_err(|e| format!("{UNSUPPORTED_DIR} のフォルダを作れません（{e}）"))?;
            let name = rel.file_name().unwrap().to_string_lossy().into_owned();
            fileops::transfer(
                lib,
                Request {
                    kind: SET_ASIDE,
                    target_id: None,
                    copy: false,
                    src: &rel,
                    dst_dir: dir,
                    name: &name,
                    on_conflict: OnConflict::Number,
                },
                &apply_none,
            )
        });
        s.reason = match result {
            Ok(dst) => Reason::SetAside {
                to: lib.root.join(dst),
            },
            Err(message) => Reason::Error {
                message: format!("{UNSUPPORTED_DIR} へ移せません（{message}）"),
            },
        };
    }
}

/// path（絶対パス）を、カテゴリか未分類のフォルダにある、対応していない形式のファイルとして確かめ、ライブラリからの相対パスを返す
fn movable(lib: &Library, path: &Path) -> Result<PathBuf, String> {
    let rel = inside(lib, path)?;
    let mut head = [0u8; 64];
    let n = fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("{} を読めません（{e}）", path.display()))?;
    // 画像として登録できる形式なら DB の行のある画像かもしれないので、動かさない
    if import::supported(&head[..n]).is_some() {
        return Err("画像として登録できる形式です".into());
    }
    Ok(rel)
}

/// path（絶対パス）が、ライブラリの中のカテゴリか未分類のフォルダにあるファイルなら、ライブラリからの相対パス
fn inside(lib: &Library, path: &Path) -> Result<PathBuf, String> {
    let bad = || format!("移せない場所のファイルです（{}）", path.display());
    let rel = path.strip_prefix(&lib.root).map_err(|_| bad())?;
    let mut names = vec![];
    for c in rel.components() {
        // .. と、. で始まる名前（.kura を含む）は差分検出が見ない場所なので受け付けない
        let Component::Normal(n) = c else {
            return Err(bad());
        };
        let n = n.to_string_lossy();
        if n.starts_with('.') {
            return Err(bad());
        }
        names.push(n);
    }
    // ライブラリの直下と `_未対応ファイル/` の下は、カテゴリでも未分類でもない
    if names.len() < 2 || names[0] == UNSUPPORTED_DIR {
        return Err(bad());
    }
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() => Ok(rel.to_path_buf()),
        Ok(_) => Err(format!("ファイルではありません（{}）", path.display())),
        Err(e) => Err(format!("{} が見つかりません（{e}）", path.display())),
    }
}

/// 重複として登録しなかったファイル path（絶対パス）を整理する（FR-109）。中身が登録済みの画像 existing と同じことを確かめ、
/// keep_registered が false なら、先に登録しなかったファイルを除けてから、existing をそのファイルのあったカテゴリへ移す（FR-402 と同じ移し方）。
/// どちらでも、登録しなかったファイルは DB の行を作らずに `.kura/trash/.duplicates/` へ移す。「ゴミ箱を空にする」で消える
pub fn tidy(
    lib: &mut Library,
    path: &Path,
    existing: i64,
    keep_registered: bool,
) -> Result<(), String> {
    let rel = inside(lib, path)?;
    let (dir, file_name) = category::locate(lib, existing)?;
    let kept = dir.join(&file_name);
    if kept == rel {
        return Err("登録済みの画像そのものです".into());
    }
    let hash: String = lib
        .conn
        .query_row("SELECT hash FROM images WHERE id = ?1", [existing], |r| {
            r.get(0)
        })
        .map_err(err)?;
    // 差分検出の後に Finder で変えられていれば、同じ画像ではなくなっているので、どちらも動かさない
    for (p, what) in [
        (path.to_path_buf(), "このファイル"),
        (lib.root.join(&kept), "登録済みの画像"),
    ] {
        let bytes =
            fs::read(&p).map_err(|e| format!("{what}を読めません（{}、{e}）", p.display()))?;
        if import::sha256(&bytes) != hash {
            return Err(format!(
                "{what}の中身が変わっています。差分を確認してから、もう一度試してください"
            ));
        }
    }
    // exFAT ではフォルダの名前が NFD で返るので、DB のカテゴリ名（NFC）にそろえて探す
    let parent: PathBuf = rel.parent().unwrap().iter().map(fileops::nfc).collect();
    let target = match keep_registered {
        true => None,
        false => Some(category::by_dir(&lib.conn, &parent)?),
    };
    let trash = Path::new(DUPLICATES_DIR);
    fs::create_dir_all(lib.root.join(trash))
        .map_err(|e| format!("ゴミ箱のフォルダを作れません（{e}）"))?;
    let name = rel.file_name().unwrap().to_string_lossy().into_owned();
    fileops::transfer(
        lib,
        Request {
            kind: TRASH_DUPLICATE,
            target_id: None,
            copy: false,
            src: &rel,
            dst_dir: trash,
            name: &name,
            on_conflict: OnConflict::Number,
        },
        &apply_none,
    )?;
    if let Some(category) = target {
        let r = category::assign(lib, &[existing], category)?;
        if let Some(f) = r.failed.into_iter().next() {
            // 登録しなかったファイルはゴミ箱の下にあり、登録済みの画像は元の場所に残っている。1枚は失われない
            return Err(format!(
                "登録済みの画像を移せません。画像は元の場所にあります（{}）",
                f.message
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::params;

    use super::*;
    use crate::category::create;
    use crate::category::tests::{files, lock, pending, row, setup, unlock};
    use crate::library::{self, TRASH_DIR};
    use crate::sync::tests::{id_of, png, scan};
    use crate::trash;

    fn unsupported(lib: &Library, rel: &str) -> Skipped {
        Skipped {
            path: lib.root.join(rel),
            reason: Reason::Unsupported,
        }
    }

    fn put_file(lib: &Library, rel: &str, body: &[u8]) {
        let path = lib.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn 対応していない形式のファイルを未対応ファイルへ移し同名には連番を付ける() {
        let (_d, mut lib) = setup();
        create(&mut lib, None, "ポーズ").unwrap();
        put_file(&lib, "_未分類/a.mp4", b"A");
        put_file(&lib, "ポーズ/a.mp4", b"B");
        let mut s = vec![
            unsupported(&lib, "_未分類/a.mp4"),
            unsupported(&lib, "ポーズ/a.mp4"),
        ];

        set_aside(&mut lib, &mut s);

        assert_eq!(files(&lib, UNSUPPORTED_DIR), ["a (2).mp4", "a.mp4"]);
        assert_eq!(files(&lib, "_未分類"), Vec::<String>::new());
        assert_eq!(files(&lib, "ポーズ"), Vec::<String>::new());
        assert_eq!(
            s[1].reason,
            Reason::SetAside {
                to: lib.root.join("_未対応ファイル/a (2).mp4")
            }
        );
        assert_eq!(s[1].path, lib.root.join("ポーズ/a.mp4"));
        assert_eq!(
            fs::read(lib.root.join("_未対応ファイル/a (2).mp4")).unwrap(),
            b"B"
        );
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 画像の形式のファイルと管理用のフォルダとライブラリの外のファイルは移さずエラーにする() {
        let (_d, mut lib) = setup();
        let outside = tempfile::tempdir().unwrap();
        png(&lib, "_未分類/a.png", 10);
        put_file(&lib, ".kura/b.mp4", b"B");
        put_file(&lib, "_未対応ファイル/c.mp4", b"C");
        put_file(&lib, "d.mp4", b"D");
        fs::write(outside.path().join("e.mp4"), b"E").unwrap();
        let mut s = vec![
            unsupported(&lib, "_未分類/a.png"),
            unsupported(&lib, ".kura/b.mp4"),
            unsupported(&lib, "_未対応ファイル/c.mp4"),
            unsupported(&lib, "_未分類/../d.mp4"),
            unsupported(&lib, "_未分類/ない.mp4"),
            Skipped {
                path: outside.path().join("e.mp4"),
                reason: Reason::Unsupported,
            },
            Skipped {
                path: lib.root.join("_未分類/a.png"),
                reason: Reason::Duplicate { existing: 1 },
            },
        ];

        set_aside(&mut lib, &mut s);

        for x in &s[..6] {
            assert!(matches!(x.reason, Reason::Error { .. }), "{x:?}");
        }
        assert_eq!(s[6].reason, Reason::Duplicate { existing: 1 });
        assert_eq!(files(&lib, "_未分類"), ["a.png"]);
        assert_eq!(files(&lib, UNSUPPORTED_DIR), ["c.mp4"]);
        assert!(lib.root.join("d.mp4").exists());
        assert!(outside.path().join("e.mp4").exists());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 移せなければファイルは元の場所に残し予定も残さない() {
        let (_d, mut lib) = setup();
        put_file(&lib, "_未分類/a.mp4", b"A");
        fs::create_dir(lib.root.join(UNSUPPORTED_DIR)).unwrap();
        let locked = lib.root.join(UNSUPPORTED_DIR);
        if !lock(&locked) {
            return;
        }
        let mut s = vec![unsupported(&lib, "_未分類/a.mp4")];

        set_aside(&mut lib, &mut s);

        unlock(&locked);
        assert!(matches!(s[0].reason, Reason::Error { .. }), "{s:?}");
        assert_eq!(files(&lib, "_未分類"), ["a.mp4"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 移したあと予定を消す前に止まった操作は開き直したときに完了させる() {
        for (kind, dst_dir) in [
            (SET_ASIDE, UNSUPPORTED_DIR),
            (TRASH_DUPLICATE, DUPLICATES_DIR),
        ] {
            let (d, lib) = setup();
            put_file(&lib, "_未分類/a.mp4", b"A");
            fs::create_dir_all(lib.root.join(dst_dir)).unwrap();
            let dst = format!("{dst_dir}/a.mp4");
            lib.conn
                .execute(
                    "INSERT INTO pending_ops(kind, target_id, copy, src, dst) VALUES (?1, NULL, 0, '_未分類/a.mp4', ?2)",
                    params![kind, dst],
                )
                .unwrap();
            fs::rename(lib.root.join("_未分類/a.mp4"), lib.root.join(&dst)).unwrap();
            drop(lib);

            let lib = library::open(d.path()).unwrap();

            assert_eq!(pending(&lib), 0, "{kind}");
            assert_eq!(files(&lib, dst_dir), ["a.mp4"]);
        }
    }

    #[test]
    fn 移す前に止まった操作は開き直したときに予定だけ消す() {
        let (d, lib) = setup();
        put_file(&lib, "_未分類/a.mp4", b"A");
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst) VALUES (?1, NULL, 0, '_未分類/a.mp4', '_未対応ファイル/a.mp4')",
                [SET_ASIDE],
            )
            .unwrap();
        drop(lib);

        let lib = library::open(d.path()).unwrap();

        assert_eq!(pending(&lib), 0);
        assert_eq!(files(&lib, "_未分類"), ["a.mp4"]);
    }

    /// 未分類に登録済みの画像と、ポーズに同じ中身のファイルを置いて差分検出し、登録しなかったファイルのパスと登録済みの画像の id を返す
    fn duplicate(lib: &mut Library) -> (PathBuf, i64) {
        create(lib, None, "ポーズ").unwrap();
        png(lib, "_未分類/a.png", 10);
        scan(lib).unwrap();
        png(lib, "ポーズ/a.png", 10);
        let r = scan(lib).unwrap();
        let existing = id_of(lib, "a.png");
        assert_eq!(r.skipped[0].reason, Reason::Duplicate { existing });
        (r.skipped[0].path.clone(), existing)
    }

    #[test]
    fn 登録済みの画像の場所に残すと登録しなかったファイルをゴミ箱の下へ移しdbは変えない() {
        let (_d, mut lib) = setup();
        let (path, existing) = duplicate(&mut lib);

        tidy(&mut lib, &path, existing, true).unwrap();

        assert_eq!(files(&lib, "ポーズ"), Vec::<String>::new());
        assert_eq!(files(&lib, "_未分類"), ["a.png"]);
        assert_eq!(row(&lib, existing), ("a.png".into(), None));
        assert_eq!(files(&lib, DUPLICATES_DIR), ["a.png"]);
        assert_eq!(pending(&lib), 0);
        // アプリのゴミ箱の一覧には出ない
        assert!(crate::gallery::trash(&lib).unwrap().is_empty());
    }

    #[test]
    fn 登録しなかったファイルの場所に残すと登録済みの画像をそのカテゴリへ移す() {
        let (_d, mut lib) = setup();
        let (path, existing) = duplicate(&mut lib);
        let pose = category::by_dir(&lib.conn, Path::new("ポーズ")).unwrap();
        assert!(pose.is_some());

        tidy(&mut lib, &path, existing, false).unwrap();

        assert_eq!(files(&lib, "ポーズ"), ["a.png"]);
        assert_eq!(files(&lib, "_未分類"), Vec::<String>::new());
        assert_eq!(row(&lib, existing), ("a.png".into(), pose));
        assert_eq!(files(&lib, DUPLICATES_DIR), ["a.png"]);
        assert_eq!(pending(&lib), 0);
        // 次の差分検出で何も変わらない
        let r = scan(&mut lib).unwrap();
        assert!(r.skipped.is_empty(), "{r:?}");
        assert_eq!((r.added, r.moved, r.missing), (0, 0, 0));
    }

    #[test]
    fn ゴミ箱の下に同名があれば連番を付ける() {
        let (_d, mut lib) = setup();
        let (path, existing) = duplicate(&mut lib);
        fs::create_dir_all(lib.root.join(DUPLICATES_DIR)).unwrap();
        fs::write(lib.root.join(DUPLICATES_DIR).join("a.png"), "前").unwrap();

        tidy(&mut lib, &path, existing, true).unwrap();

        assert_eq!(files(&lib, DUPLICATES_DIR), ["a (2).png", "a.png"]);
    }

    #[test]
    fn 中身が変わったファイルやゴミ箱の画像は整理せずどちらも動かさない() {
        let (_d, mut lib) = setup();
        let (path, existing) = duplicate(&mut lib);
        png(&lib, "ポーズ/a.png", 99);

        assert!(tidy(&mut lib, &path, existing, true).is_err());
        assert!(tidy(&mut lib, &path, existing, false).is_err());
        png(&lib, "ポーズ/a.png", 10);
        png(&lib, "_未分類/a.png", 99);
        assert!(tidy(&mut lib, &path, existing, true).is_err());
        png(&lib, "_未分類/a.png", 10);
        trash::trash(&mut lib, &[existing]).unwrap();
        assert!(tidy(&mut lib, &path, existing, true).is_err());

        assert_eq!(files(&lib, "ポーズ"), ["a.png"]);
        assert!(!lib.root.join(DUPLICATES_DIR).exists());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 登録済みの画像を移せなければ登録しなかったファイルだけをゴミ箱の下へ移しエラーにする() {
        let (_d, mut lib) = setup();
        let (path, existing) = duplicate(&mut lib);
        let src = lib.root.join("_未分類");
        if !lock(&src) {
            return;
        }

        let r = tidy(&mut lib, &path, existing, false);

        unlock(&src);
        assert!(r.is_err());
        assert_eq!(files(&lib, "_未分類"), ["a.png"]);
        assert_eq!(row(&lib, existing), ("a.png".into(), None));
        assert_eq!(files(&lib, DUPLICATES_DIR), ["a.png"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ゴミ箱を空にすると登録しなかったファイルも消す() {
        let (_d, mut lib) = setup();
        let (path, existing) = duplicate(&mut lib);
        tidy(&mut lib, &path, existing, true).unwrap();

        trash::empty(&mut lib).unwrap();

        assert!(!lib.root.join(DUPLICATES_DIR).exists());
        assert_eq!(files(&lib, "_未分類"), ["a.png"]);
        assert!(lib.root.join(TRASH_DIR).exists());
    }
}
