//! ライブラリ全体から元が同じ画像の組を探す（FR-611）。基準は5.6 の「元が同じ画像の整理」、
//! しきい値は4章の「元が同じ画像（FR-610、FR-611）のしきい値」
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use crate::features;
use crate::library::{err, Access};
use crate::manifest::Aspect;

/// 元が同じとみなす、内容のそろえる前のコサイン類似度
pub const SAME: f32 = 0.98;
/// 比べる観点。構図とポーズは使わない（5.6 の「元が同じ画像の整理」）
pub const CONTENT: &str = "content";

/// 探す回の合図。探し始めるたびと、中止するたびに1つ増やす（calc.rs の generation と同じ作り）
#[derive(Default)]
pub struct Search(AtomicU64);

impl Search {
    /// 前の回を止めて、新しい回の番号を返す
    fn begin(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn cancel(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    fn stale(&self, gen: u64) -> bool {
        self.0.load(Ordering::SeqCst) != gen
    }
}

/// 8つずつ足す内積。足す順を分けると、コンパイラが SIMD の命令にできる
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0.0f32; 8];
    let ((ca, ra), (cb, rb)) = (a.as_chunks::<8>(), b.as_chunks::<8>());
    let tail: f32 = ra.iter().zip(rb).map(|(x, y)| x * y).sum();
    for (x, y) in ca.iter().zip(cb) {
        for ((s, x), y) in acc.iter_mut().zip(x).zip(y) {
            *s += x * y;
        }
    }
    acc.iter().sum::<f32>() + tail
}

/// 進み具合。done と total は比べる2枚の組の数
#[derive(Clone, Copy, serde::Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

/// 全部の2枚を比べ、元が同じとみなした2枚をつないだ組（2枚以上）を返す。組の中は id の昇順、
/// 組は先頭の id の昇順。stop が true を返したら None。progress はおよそ0.1秒ごとに呼ぶ
fn group(
    ids: &[i64],
    vectors: &[f32],
    dim: usize,
    stop: &(dyn Fn() -> bool + Sync),
    progress: &mut dyn FnMut(Progress),
) -> Option<Vec<Vec<i64>>> {
    let n = ids.len();
    let total = n * n.saturating_sub(1) / 2;
    let row = |i: usize| &vectors[i * dim..(i + 1) * dim];
    let threads = thread::available_parallelism()
        .map_or(1, |p| p.get())
        .min(n.max(1));
    let done = AtomicUsize::new(0);
    let finished = AtomicUsize::new(0);
    // 各スレッドは i を threads 個おきに受け持つ。行ごとの組の数が違っても、受け持ちの量がほぼそろう
    let pairs: Vec<Option<Vec<(usize, usize)>>> = thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|t| {
                let (done, finished) = (&done, &finished);
                scope.spawn(move || {
                    let mut found = Vec::new();
                    let mut result = Some(());
                    for i in (t..n).step_by(threads) {
                        if stop() {
                            result = None;
                            break;
                        }
                        let a = row(i);
                        for j in i + 1..n {
                            if dot(a, row(j)) >= SAME {
                                found.push((i, j));
                            }
                        }
                        done.fetch_add(n - 1 - i, Ordering::Relaxed);
                    }
                    finished.fetch_add(1, Ordering::SeqCst);
                    result.map(|_| found)
                })
            })
            .collect();
        while finished.load(Ordering::SeqCst) < threads {
            progress(Progress {
                done: done.load(Ordering::Relaxed),
                total,
            });
            thread::sleep(Duration::from_millis(100));
        }
        workers.into_iter().map(|w| w.join().unwrap()).collect()
    });
    let mut parent: Vec<usize> = (0..n).collect();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    for found in pairs {
        for (i, j) in found? {
            let (a, b) = (root(&mut parent, i), root(&mut parent, j));
            parent[a.max(b)] = a.min(b);
        }
    }
    progress(Progress { done: total, total });
    let mut groups: Vec<Vec<i64>> = vec![Vec::new(); n];
    for (i, &id) in ids.iter().enumerate() {
        let r = root(&mut parent, i);
        groups[r].push(id);
    }
    let mut groups: Vec<Vec<i64>> = groups.into_iter().filter(|g| g.len() >= 2).collect();
    for g in &mut groups {
        g.sort_unstable();
    }
    groups.sort_unstable_by_key(|g| g[0]);
    Some(groups)
}

/// 比べる画像（ゴミ箱でも「見つからない」でもなく、内容の特徴量がある画像）の id と、その内容の特徴量を読む。ロックはこの間だけ持つ。features.db がなければ空
fn load(lib: &impl Access, content: &Aspect) -> Result<(Vec<i64>, Vec<f32>), String> {
    lib.with(|l| {
        // 類似画像検索を使ったことのないライブラリには features.db を作らない（設計メモ2章）
        if !features::path(&l.root).exists() {
            return Ok((Vec::new(), Vec::new()));
        }
        let images: Vec<(i64, String)> = {
            let mut stmt = l
                .conn
                .prepare(
                    "SELECT id, hash FROM images
                     WHERE deleted_at IS NULL AND missing_at IS NULL ORDER BY id",
                )
                .map_err(err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?;
            rows.collect::<Result<_, _>>().map_err(err)?
        };
        let loaded: std::collections::HashMap<String, Vec<f32>> =
            l.with_features(|s| s.load(content))?.into_iter().collect();
        let mut ids = Vec::new();
        let mut vectors = Vec::new();
        for (id, hash) in images {
            if let Some(v) = loaded.get(&hash) {
                ids.push(id);
                vectors.extend_from_slice(v);
            }
        }
        Ok((ids, vectors))
    })
}

/// ライブラリ全体から元が同じ画像の組を探す。中止されたら None。前の回が動いていれば止める
pub fn find(
    lib: &impl Access,
    search: &Search,
    aspects: &[Aspect],
    progress: &mut dyn FnMut(Progress),
) -> Result<Option<Vec<Vec<i64>>>, String> {
    let gen = search.begin();
    let content = aspects
        .iter()
        .find(|a| a.aspect == CONTENT)
        .ok_or("内容の観点が model.json にありません")?;
    let (ids, vectors) = load(lib, content)?;
    if search.stale(gen) {
        return Ok(None);
    }
    let groups = group(&ids, &vectors, content.dim, &|| search.stale(gen), progress);
    // 比べ終えた後に中止されたときも、結果を出さない
    Ok(groups.filter(|_| !search.stale(gen)))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rusqlite::params;

    use super::*;
    use crate::features::tests::aspect;
    use crate::library::{self, Library};

    #[test]
    fn 内積は素直に足した値と合う() {
        let a: Vec<f32> = (0..21).map(|i| i as f32 * 0.1).collect();
        let b: Vec<f32> = (0..21).map(|i| 1.0 - i as f32 * 0.05).collect();
        let plain: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        assert!((dot(&a, &b) - plain).abs() < 1e-4);
    }

    /// 長さ1の2次元ベクトル。角度（度）で向きを決める。cos(11.5°) ≒ 0.98
    fn unit(deg: f32) -> [f32; 2] {
        let r = deg.to_radians();
        [r.cos(), r.sin()]
    }

    fn open() -> (tempfile::TempDir, Mutex<Option<Library>>) {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        (dir, Mutex::new(Some(lib)))
    }

    fn content() -> Aspect {
        aspect(CONTENT, "m1", 2)
    }

    /// 画像を1枚足して id を返す。state は "" か "trash" か "missing"。deg があれば特徴量を書く
    fn add(lib: &Mutex<Option<Library>>, name: &str, state: &str, deg: Option<f32>) -> i64 {
        let (deleted, missing) = match state {
            "trash" => (Some(1), None),
            "missing" => (None, Some(1)),
            _ => (None, None),
        };
        lib.with(|l| {
            l.conn
                .execute(
                    "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                        imported_at, registered_at, deleted_at, missing_at)
                     VALUES (?1, ?1, 1, 1, 1, 1, '#808080', 1, 1, ?2, ?3)",
                    params![name, deleted, missing],
                )
                .unwrap();
            let id = l.conn.last_insert_rowid();
            if let Some(deg) = deg {
                let c = content();
                l.with_features(|s| s.put_vectors(name, &[(&c, &unit(deg)[..])], 1))?;
            }
            Ok(id)
        })
        .unwrap()
    }

    fn find_all(lib: &Mutex<Option<Library>>) -> Vec<Vec<i64>> {
        find(lib, &Search::default(), &[content()], &mut |_| {})
            .unwrap()
            .unwrap()
    }

    #[test]
    fn 元が同じ2枚をつないで組にする() {
        let (_d, lib) = open();
        // a と b、b と c は元が同じ（10°差）。a と c は20°差で、b を通して1つの組になる
        let a = add(&lib, "a.jpg", "", Some(0.0));
        let b = add(&lib, "b.jpg", "", Some(10.0));
        let c = add(&lib, "c.jpg", "", Some(20.0));
        // 離れた2枚の組と、どこにもつながらない1枚
        let d = add(&lib, "d.jpg", "", Some(120.0));
        let e = add(&lib, "e.jpg", "", Some(130.0));
        add(&lib, "f.jpg", "", Some(200.0));
        assert_eq!(find_all(&lib), [vec![a, b, c], vec![d, e]]);
    }

    #[test]
    fn 名前が写しの形でもしきい値は下がらない() {
        let (_d, lib) = open();
        // 30°差（0.866）。名前が写しの形でも、0.98 に届かなければ組にしない
        add(&lib, "abcde.jpg", "", Some(0.0));
        add(&lib, "abcde 2.jpg", "", Some(30.0));
        add(&lib, "18.png", "", Some(100.0));
        add(&lib, "18 (1).png", "", Some(130.0));
        assert!(find_all(&lib).is_empty());
    }

    #[test]
    fn ゴミ箱と見つからないと未計算の画像は比べない() {
        let (_d, lib) = open();
        let a = add(&lib, "a.jpg", "", Some(0.0));
        add(&lib, "trash.jpg", "trash", Some(1.0));
        add(&lib, "missing.jpg", "missing", Some(2.0));
        add(&lib, "none.jpg", "", None);
        assert!(find_all(&lib).is_empty());
        let b = add(&lib, "b.jpg", "", Some(3.0));
        assert_eq!(find_all(&lib), [vec![a, b]]);
    }

    #[test]
    fn features_dbのないライブラリでは作らずに空を返す() {
        let (_d, lib) = open();
        add(&lib, "a.jpg", "", None);
        assert!(find_all(&lib).is_empty());
        let root = lib.with(|l| Ok(l.root.clone())).unwrap();
        assert!(!features::path(&root).exists());
    }

    #[test]
    fn 中止するとnoneを返す() {
        let (_d, lib) = open();
        for i in 0..50 {
            add(&lib, &format!("{i}.jpg"), "", Some(i as f32));
        }
        let search = Search::default();
        let r = find(&lib, &search, &[content()], &mut |_| search.cancel()).unwrap();
        assert!(r.is_none());
        // 次の回は中止に左右されない
        let r = find(&lib, &search, &[content()], &mut |_| {}).unwrap();
        assert!(r.is_some());
    }

    #[test]
    fn 進み具合は最後に全部の組の数になる() {
        let (_d, lib) = open();
        for i in 0..5 {
            add(&lib, &format!("{i}.jpg"), "", Some(i as f32 * 50.0));
        }
        let mut last = None;
        find(&lib, &Search::default(), &[content()], &mut |p| {
            last = Some(p)
        })
        .unwrap();
        let p = last.unwrap();
        assert_eq!((p.done, p.total), (10, 10));
    }

    /// FR-611 の計測（2万枚で60秒以内）。features.db から読む時間も含める。
    /// `cargo test --release 元が同じ画像の組の2万件の計測 -- --ignored --nocapture` で流す。
    /// 768次元の乱数のベクトルに、100組の写し（少しずらしたベクトル）を混ぜる
    #[test]
    #[ignore]
    fn 元が同じ画像の組の2万件の計測() {
        const N: usize = 20_000;
        let c = aspect(CONTENT, "siglip2-base-patch16-224", 768);
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut random = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / (1u64 << 24) as f32 - 0.5
        };
        let normalize = |v: Vec<f32>| {
            let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            v.into_iter().map(|x| x / n).collect::<Vec<f32>>()
        };
        let (_d, lib) = open();
        let mut last = Vec::new();
        lib.with(|l| {
            let tx = l.conn.unchecked_transaction().unwrap();
            for i in 0..N {
                tx.execute(
                    "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                        imported_at, registered_at)
                     VALUES (?1, ?1, 1, 1, 1, 1, '#808080', 1, 1)",
                    params![format!("{i}.jpg")],
                )
                .unwrap();
            }
            tx.commit().unwrap();
            for i in 0..N {
                let v = if i % 200 == 1 {
                    normalize(last.iter().map(|x| x + random() * 0.02).collect())
                } else {
                    normalize((0..768).map(|_| random()).collect())
                };
                l.with_features(|s| s.put_vectors(&format!("{i}.jpg"), &[(&c, &v[..])], 1))?;
                last = v;
            }
            Ok(())
        })
        .unwrap();
        for run in 0..3 {
            let start = std::time::Instant::now();
            let groups = find(&lib, &Search::default(), &[c.clone()], &mut |_| {})
                .unwrap()
                .unwrap();
            eprintln!(
                "{run}回目：{N}枚、{}スレッド、{:?}（{}組）",
                thread::available_parallelism().map_or(1, |p| p.get()),
                start.elapsed(),
                groups.len()
            );
            assert_eq!(groups.len(), 100);
        }
    }
}
