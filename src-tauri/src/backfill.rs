use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{PoisonError, RwLock, RwLockReadGuard, TryLockError};

use serde::Serialize;

use crate::gallery;
use crate::library::{err, Access, Library};
use crate::source;

/// 元URLの補完（FR-208）の件数。done は調べ終えた対象の数で、filled・none・failed の合計
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Counts {
    pub total: usize,
    pub done: usize,
    pub filled: usize,
    pub none: usize,
    pub failed: usize,
    /// 元URLが一方でも登録済みの画像と、ゴミ箱・見つからない画像
    pub excluded: usize,
    pub cancelled: bool,
}

/// 補完と、ファイルを動かす操作（取り込み・差分検出・名前変更・移動・削除）とライブラリ切り替えを
/// 重ねないための門。補完は書き込み側を取り、ほかは読み取り側を取って補完の終了か中断まで待つ。
/// ほかの処理の途中では補完を始めない
#[derive(Default)]
pub struct Gate {
    lock: RwLock<()>,
    cancel: AtomicBool,
}

impl Gate {
    /// 補完の途中なら終わるまで待つ。返り値を持つ間は補完を始めさせない
    pub fn wait(&self) -> RwLockReadGuard<'_, ()> {
        self.lock.read().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn run(&self, lib: &impl Access, progress: impl FnMut(&Counts)) -> Result<Counts, String> {
        let _held =
            match self.lock.try_write() {
                Ok(g) => g,
                Err(TryLockError::Poisoned(e)) => e.into_inner(),
                Err(TryLockError::WouldBlock) => return Err(
                    "取り込みや Finder での変更の反映などが終わってから、もう一度補完してください"
                        .into(),
                ),
            };
        self.cancel.store(false, Ordering::Relaxed);
        run(lib, &self.cancel, progress)
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// 元URLが未登録で、ゴミ箱にも見つからないにも入っていない画像のファイル。返り値の2つ目は対象外の数
fn targets(lib: &Library) -> Result<(Vec<(i64, PathBuf)>, usize), String> {
    let ids = lib
        .conn
        .prepare(
            "SELECT id FROM images WHERE deleted_at IS NULL AND missing_at IS NULL
             AND id NOT IN (SELECT image_id FROM image_sources) ORDER BY id",
        )
        .and_then(|mut s| {
            s.query_map([], |r| r.get(0))?
                .collect::<Result<Vec<i64>, _>>()
        })
        .map_err(err)?;
    let all: i64 = lib
        .conn
        .query_row("SELECT count(*) FROM images", [], |r| r.get(0))
        .map_err(err)?;
    let files = ids
        .into_iter()
        .map(|id| Ok((id, gallery::detail(lib, id)?.path)))
        .collect::<Result<Vec<_>, String>>()?;
    let excluded = all as usize - files.len();
    Ok((files, excluded))
}

/// 対象の画像のダウンロード元の記録を、ライブラリ内のファイルから1枚ずつ読んで保存する。
/// 記録はロックの外で読み、保存するときだけロックを取る。cancel が立ったら次の画像へ進まずに終える
fn run(
    lib: &impl Access,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&Counts),
) -> Result<Counts, String> {
    let (files, excluded) = lib.with(|l| targets(l))?;
    let mut c = Counts {
        total: files.len(),
        excluded,
        ..Counts::default()
    };
    progress(&c);
    for (id, path) in files {
        if cancel.load(Ordering::Relaxed) {
            c.cancelled = true;
            break;
        }
        let read = source::read(&path);
        match (read.source, read.note) {
            (Some(s), _) => {
                lib.with(|l| source::save(&l.conn, id, &s))?;
                c.filled += 1;
            }
            (None, Some(note)) => {
                log::warn!("元URLを補完できません：{}：{note}", path.display());
                c.failed += 1;
            }
            (None, None) => c.none += 1,
        }
        c.done += 1;
        progress(&c);
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;

    use image::{Rgb, RgbImage};

    use super::*;
    use crate::source::tests::{binary, set};

    const IMAGE: &str = "https://img.example.com/a.png";
    const PAGE: &str = "https://example.com/page";

    /// 記録のない画像を差分検出で登録したライブラリ。旧版で取り込み済みの画像の代わり
    fn setup(names: &[&str]) -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = crate::library::create(dir.path()).unwrap();
        for (i, name) in names.iter().enumerate() {
            RgbImage::from_pixel(4, 4, Rgb([i as u8 * 10, 0, 0]))
                .save_with_format(lib.root.join("_未分類").join(name), image::ImageFormat::Png)
                .unwrap();
        }
        crate::sync::scan(&RefCell::new(&mut lib), |_, _| {}).unwrap();
        (dir, lib)
    }

    fn id_of(lib: &Library, name: &str) -> i64 {
        lib.conn
            .query_row("SELECT id FROM images WHERE file_name = ?1", [name], |r| {
                r.get(0)
            })
            .unwrap()
    }

    fn where_from(lib: &Library, name: &str, items: &[&str]) {
        set(&lib.root.join("_未分類").join(name), &binary(items));
    }

    fn sources(lib: &Library) -> Vec<(String, Option<String>, Option<String>)> {
        lib.conn
            .prepare(
                "SELECT file_name, image_url, page_url FROM image_sources
                 JOIN images ON images.id = image_id ORDER BY file_name",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn backfill(lib: &mut Library) -> Counts {
        Gate::default().run(&RefCell::new(lib), |_| {}).unwrap()
    }

    #[test]
    fn 未登録の画像だけをライブラリ内のファイルから補完し件数を分ける() {
        let (_d, mut lib) = setup(&["a.png", "b.png", "c.png", "d.png"]);
        where_from(&lib, "a.png", &[IMAGE, PAGE]);
        where_from(&lib, "b.png", &["壊れた記録", "ftp://example.com/"]);
        // c は記録なし。d は画像URLだけが不正で、掲載ページURLだけを保存する
        where_from(&lib, "d.png", &["壊れた記録", PAGE]);

        let c = backfill(&mut lib);

        assert_eq!(
            c,
            Counts {
                total: 4,
                done: 4,
                filled: 2,
                none: 1,
                failed: 1,
                excluded: 0,
                cancelled: false
            }
        );
        assert_eq!(
            sources(&lib),
            [
                ("a.png".into(), Some(IMAGE.into()), Some(PAGE.into())),
                ("d.png".into(), None, Some(PAGE.into())),
            ]
        );
    }

    #[test]
    fn 一方でも登録済みの画像とゴミ箱と見つからない画像は対象外にし既存の値を変えない() {
        let (_d, mut lib) = setup(&["a.png", "b.png", "c.png", "d.png"]);
        let a = id_of(&lib, "a.png");
        lib.conn
            .execute(
                "INSERT INTO image_sources(image_id, image_url, page_url, fetched_at) VALUES (?1, NULL, 'https://example.com/old', 1)",
                [a],
            )
            .unwrap();
        for name in ["a.png", "b.png", "c.png"] {
            where_from(&lib, name, &[IMAGE, PAGE]);
        }
        let b = id_of(&lib, "b.png");
        crate::trash::trash(&mut lib, &[b]).unwrap();
        fs::remove_file(lib.root.join("_未分類/c.png")).unwrap();
        crate::sync::scan(&RefCell::new(&mut lib), |_, _| {}).unwrap();

        let c = backfill(&mut lib);

        assert_eq!((c.total, c.excluded, c.filled, c.none), (1, 3, 0, 1));
        assert_eq!(
            sources(&lib),
            [("a.png".into(), None, Some("https://example.com/old".into()))]
        );
    }

    #[test]
    fn 中断までに保存した元urlは残り再実行で残りを補完する() {
        let (_d, mut lib) = setup(&["a.png", "b.png", "c.png"]);
        for name in ["a.png", "b.png", "c.png"] {
            where_from(&lib, name, &[IMAGE]);
        }
        let gate = Gate::default();

        let c = gate
            .run(&RefCell::new(&mut lib), |c| {
                if c.done == 1 {
                    gate.cancel();
                }
            })
            .unwrap();

        assert_eq!((c.done, c.filled, c.cancelled), (1, 1, true));
        assert_eq!(sources(&lib).len(), 1);

        let c = gate.run(&RefCell::new(&mut lib), |_| {}).unwrap();
        assert_eq!(
            (c.total, c.filled, c.excluded, c.cancelled),
            (2, 2, 1, false)
        );
        assert_eq!(sources(&lib).len(), 3);
    }

    #[test]
    fn ファイルを読めない画像は失敗に数えて続ける() {
        let (_d, mut lib) = setup(&["a.png", "b.png"]);
        // DB にはまだ見つからないと記録されていない、消えたファイル
        fs::remove_file(lib.root.join("_未分類/a.png")).unwrap();
        where_from(&lib, "b.png", &[IMAGE]);

        let c = backfill(&mut lib);

        assert_eq!((c.failed, c.filled), (1, 1));
    }

    #[test]
    fn ほかの処理の途中では始めず補完の途中のほかの処理は終わるまで待つ() {
        let (_d, mut lib) = setup(&["a.png"]);
        let gate = Gate::default();
        let lib = RefCell::new(&mut lib);
        {
            let _other = gate.wait();
            assert!(gate.run(&lib, |_| {}).unwrap_err().contains("終わってから"));
        }
        gate.run(&lib, |_| {
            // 補完の途中は読み取り側を取れない
            assert!(gate.lock.try_read().is_err());
        })
        .unwrap();
        drop(gate.wait());
    }
}
