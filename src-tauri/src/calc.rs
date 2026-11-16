//! 未計算の画像の特徴量を、1本のスレッドで順に計算して features.db に保存する（FR-604）。
//! ライブラリの切り替え・ON/OFF・失敗の扱いは docs/tasks/phase3-design.md の3章のとおり
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;

use serde::Serialize;

use crate::library::{self, err, Access, Library, DRIVE_UNREADABLE, NOT_OPEN};
use crate::manifest::Aspect;
use crate::worker;

/// ワーカーを起動できない、落ちた、返事がない、決まりと違う行
const STOPPED: &str = "特徴量の計算が止まりました。設定の「再計算」でもう一度試せます";
/// features.db や kura.db のエラー
const UNSAVED: &str = "特徴量を保存できません。設定の「再計算」でもう一度試せます";

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Status {
    /// 計算のスレッドが、未計算の画像を処理している
    pub running: bool,
    /// 対象の画像（ゴミ箱と「見つからない」を除く）のうち、計算済みの枚数
    pub done: usize,
    /// 対象の画像の枚数
    pub total: usize,
    /// 対象の未計算の画像のうち、この起動の中で計算できなかった枚数
    pub failed: usize,
    /// 計算が止まった理由。次のきっかけで計算を始めるときに消える
    pub error: Option<String>,
}

/// 計算の1回分が外に頼るもの。テストでは偽物を渡す
pub struct Env {
    /// 類似画像検索が ON で、モデルのファイルがそろっている
    pub enabled: Box<dyn Fn() -> bool + Send + Sync>,
    pub aspects: Vec<Aspect>,
    pub start: Box<dyn Fn() -> Result<Box<dyn Compute>, String> + Send + Sync>,
    pub notify: Box<dyn Fn(&Status) + Send + Sync>,
}

pub trait Compute: Send {
    fn compute(&mut self, thumb: &Path) -> Result<Vec<Vec<f32>>, worker::Failure>;
}

impl Compute for worker::Worker {
    fn compute(&mut self, thumb: &Path) -> Result<Vec<Vec<f32>>, worker::Failure> {
        worker::Worker::compute(self, thumb)
    }
}

/// 計算のスレッドへの合図と、画面に見せる状態。Tauri の State に入れる
#[derive(Clone)]
pub struct Calc(Arc<Inner>);

struct Inner {
    /// ライブラリを閉じる・切り替える、OFF にするたびに1つ増やす
    generation: AtomicU64,
    /// 起こす合図。計算中に立ったら、今の回が終わった後にもう1回まわす
    wake: (Mutex<bool>, Condvar),
    status: Mutex<Status>,
    /// この起動の中で計算できなかった画像。（ライブラリのルート、ハッシュ）の組
    failed: Mutex<HashSet<(PathBuf, String)>>,
    env: Env,
}

/// 計算の結果を書く直前に、同じロックの中で確かめたこと
enum Check {
    /// ライブラリが閉じられた・切り替えられた、または止められた
    Stale,
    /// 画像の行がもうない（完全削除、「一覧から外す」）
    Gone,
    /// まだ有効。Ok の結果なら書いた
    Valid,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Calc {
    /// スレッドを作らない。テストはこれで作って pass を直接呼ぶ
    pub fn new(env: Env) -> Calc {
        Calc(Arc::new(Inner {
            generation: AtomicU64::new(0),
            wake: (Mutex::new(false), Condvar::new()),
            status: Mutex::new(Status::default()),
            failed: Mutex::new(HashSet::new()),
            env,
        }))
    }

    /// new して、合図を待って pass を呼ぶスレッドを1本作る。アプリの起動時に1回だけ呼ぶ
    pub fn spawn(env: Env, lib: Arc<Mutex<Option<Library>>>) -> Calc {
        let calc = Calc::new(env);
        let c = calc.clone();
        thread::spawn(move || loop {
            {
                let (flag, cv) = &c.0.wake;
                let mut up = lock(flag);
                while !*up {
                    up = cv.wait(up).unwrap_or_else(PoisonError::into_inner);
                }
                *up = false;
            }
            c.pass(&*lib);
        });
        calc
    }

    fn generation(&self) -> u64 {
        self.0.generation.load(Ordering::SeqCst)
    }

    /// 状態を変えて知らせる。知らせる間は状態のロックを持たない
    fn update(&self, f: impl FnOnce(&mut Status)) {
        let s = {
            let mut s = lock(&self.0.status);
            f(&mut s);
            s.clone()
        };
        (self.0.env.notify)(&s);
    }

    /// 止まった理由を状態に入れる。元の文はログにだけ残す
    fn fail(&self, shown: &str, e: &str) {
        log::error!("特徴量の計算を止めます：{e}");
        let shown = shown.to_string();
        self.update(|s| s.error = Some(shown));
    }

    /// ライブラリのエラーを、画面に出す文にする
    fn fail_library(&self, e: &str) {
        self.fail(
            if e == DRIVE_UNREADABLE {
                DRIVE_UNREADABLE
            } else {
                UNSAVED
            },
            e,
        );
    }

    /// 計算の1回分
    pub fn pass(&self, lib: &impl Access) {
        let gen = self.generation();
        lock(&self.0.status).error = None;
        if !(self.0.env.enabled)() {
            self.update(|s| *s = Status::default());
            return;
        }
        let aspects = &self.0.env.aspects;
        let planning = std::time::Instant::now();
        let plan = lib.with(|l| {
            let root = l.root.clone();
            let all = hashes(l, "SELECT hash FROM images")?;
            let targets = hashes(
                l,
                "SELECT hash FROM images WHERE deleted_at IS NULL AND missing_at IS NULL
                 ORDER BY imported_at DESC, id DESC",
            )?;
            let computed = l.with_features(|s| {
                s.sweep(&all.iter().cloned().collect(), aspects)?;
                s.computed(aspects)
            })?;
            Ok((root, targets, computed))
        });
        let (root, targets, computed) = match plan {
            Ok(plan) => plan,
            Err(e) if e == NOT_OPEN => {
                self.update(|s| *s = Status::default());
                return;
            }
            Err(e) => return self.fail_library(&e),
        };
        let (pending, failed): (Vec<String>, Vec<String>) = {
            let failed = lock(&self.0.failed);
            targets
                .iter()
                .filter(|h| !computed.contains(*h))
                .cloned()
                .partition(|h| !failed.contains(&(root.clone(), h.clone())))
        };
        self.update(|s| {
            *s = Status {
                running: false,
                done: targets.len() - pending.len() - failed.len(),
                total: targets.len(),
                failed: failed.len(),
                error: None,
            }
        });
        // 計画はロックの中で2万件の sweep と computed を流すので、待たせている時間をログで追えるようにする
        log::info!(
            "特徴量の計算の計画：対象 {}枚、未計算 {}枚、失敗 {}枚（{}ms）",
            targets.len(),
            pending.len(),
            failed.len(),
            planning.elapsed().as_millis()
        );
        if pending.is_empty() {
            return;
        }
        let mut worker = match (self.0.env.start)() {
            Ok(w) => w,
            Err(e) => return self.fail(STOPPED, &e),
        };
        self.update(|s| s.running = true);
        for hash in &pending {
            if self.generation() != gen {
                break;
            }
            let result = worker.compute(&library::thumb_path(&root, hash));
            if self.generation() != gen {
                break;
            }
            let check = lib.with(|l| {
                if self.generation() != gen || l.root != root {
                    return Ok(Check::Stale);
                }
                let exists: bool = l
                    .conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM images WHERE hash = ?1)",
                        [hash],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                if !exists {
                    return Ok(Check::Gone);
                }
                if let Ok(vectors) = &result {
                    let pairs: Vec<(&Aspect, &[f32])> = aspects
                        .iter()
                        .zip(vectors)
                        .map(|(a, v)| (a, v.as_slice()))
                        .collect();
                    l.with_features(|s| s.put(hash, &pairs, now()))?;
                }
                Ok(Check::Valid)
            });
            let valid = match check {
                Err(e) if e == NOT_OPEN => break,
                Err(e) => {
                    self.fail_library(&e);
                    break;
                }
                Ok(Check::Stale) => break,
                Ok(Check::Gone) => false,
                Ok(Check::Valid) => true,
            };
            match result {
                Ok(_) => {
                    if valid {
                        self.update(|s| s.done += 1);
                    }
                }
                Err(worker::Failure::Image(e)) => {
                    if valid {
                        self.mark_failed(&root, hash);
                        log::warn!("特徴量を計算できません（{hash}、{e}）");
                    }
                }
                Err(worker::Failure::Dead(e)) => {
                    if valid {
                        self.mark_failed(&root, hash);
                    }
                    self.fail(STOPPED, &e);
                    break;
                }
            }
        }
        drop(worker);
        self.update(|s| s.running = false);
    }

    fn mark_failed(&self, root: &Path, hash: &str) {
        lock(&self.0.failed).insert((root.to_path_buf(), hash.to_string()));
        self.update(|s| s.failed += 1);
    }

    /// 未計算の画像があるかもしれない。何度呼んでもよい
    pub fn wake(&self) {
        let (flag, cv) = &self.0.wake;
        *lock(flag) = true;
        cv.notify_one();
    }

    /// 今の回を止める（generation を増やして wake する）
    pub fn halt(&self) {
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        self.wake();
    }

    /// failed と error を消して wake する（「再計算」）
    pub fn retry(&self) {
        lock(&self.0.failed).clear();
        lock(&self.0.status).error = None;
        self.wake();
    }

    pub fn status(&self) -> Status {
        lock(&self.0.status).clone()
    }
}

fn hashes(l: &Library, sql: &str) -> Result<Vec<String>, String> {
    let mut stmt = l.conn.prepare(sql).map_err(err)?;
    let rows = stmt
        .query_map([], |r| r.get(0))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err);
    rows
}

/// UNIX 時間のミリ秒
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use rusqlite::params;
    use tempfile::TempDir;

    use super::*;
    use crate::features::tests::aspect;
    use worker::Failure;

    type Behave = Box<dyn FnMut(&str) -> Result<Vec<Vec<f32>>, Failure> + Send>;

    fn aspects() -> Vec<Aspect> {
        vec![aspect("content", "m1", 2), aspect("composition", "c1", 3)]
    }

    fn good() -> Result<Vec<Vec<f32>>, Failure> {
        Ok(vec![vec![1.0, 0.0], vec![0.0, 1.0, 0.0]])
    }

    /// 偽のワーカー。サムネイルの名前からハッシュを取り、behave に結果を決めさせる
    struct Fake {
        behave: Arc<Mutex<Behave>>,
        seen: Arc<Mutex<Vec<String>>>,
        drops: Arc<AtomicUsize>,
    }

    impl Compute for Fake {
        fn compute(&mut self, thumb: &Path) -> Result<Vec<Vec<f32>>, Failure> {
            let hash = thumb.file_stem().unwrap().to_str().unwrap().to_string();
            lock(&self.seen).push(hash.clone());
            (lock(&self.behave))(&hash)
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Rig {
        dir: TempDir,
        lib: Arc<Mutex<Option<Library>>>,
        calc: Calc,
        enabled: Arc<AtomicBool>,
        start_fails: Arc<AtomicBool>,
        starts: Arc<AtomicUsize>,
        behave: Arc<Mutex<Behave>>,
        seen: Arc<Mutex<Vec<String>>>,
        drops: Arc<AtomicUsize>,
        /// behave の中から halt を呼ぶための Calc の写し
        me: Arc<OnceLock<Calc>>,
    }

    fn rig_with(threaded: bool) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let lib = Arc::new(Mutex::new(Some(library::create(dir.path()).unwrap())));
        let enabled = Arc::new(AtomicBool::new(true));
        let start_fails = Arc::new(AtomicBool::new(false));
        let starts = Arc::new(AtomicUsize::new(0));
        let behave: Arc<Mutex<Behave>> = Arc::new(Mutex::new(Box::new(|_| good())));
        let seen = Arc::new(Mutex::new(vec![]));
        let drops = Arc::new(AtomicUsize::new(0));
        let env = Env {
            enabled: Box::new({
                let e = enabled.clone();
                move || e.load(Ordering::SeqCst)
            }),
            aspects: aspects(),
            start: Box::new({
                let (fails, starts, behave, seen, drops) = (
                    start_fails.clone(),
                    starts.clone(),
                    behave.clone(),
                    seen.clone(),
                    drops.clone(),
                );
                move || {
                    starts.fetch_add(1, Ordering::SeqCst);
                    if fails.load(Ordering::SeqCst) {
                        return Err("偽のワーカーを起動できない".into());
                    }
                    Ok(Box::new(Fake {
                        behave: behave.clone(),
                        seen: seen.clone(),
                        drops: drops.clone(),
                    }) as Box<dyn Compute>)
                }
            }),
            notify: Box::new(|_| {}),
        };
        let calc = if threaded {
            Calc::spawn(env, lib.clone())
        } else {
            Calc::new(env)
        };
        let me = Arc::new(OnceLock::new());
        me.set(calc.clone()).ok();
        Rig {
            dir,
            lib,
            calc,
            enabled,
            start_fails,
            starts,
            behave,
            seen,
            drops,
            me,
        }
    }

    fn rig() -> Rig {
        rig_with(false)
    }

    impl Rig {
        fn pass(&self) {
            self.calc.pass(&*self.lib);
        }

        fn behave(&self, f: impl FnMut(&str) -> Result<Vec<Vec<f32>>, Failure> + Send + 'static) {
            *lock(&self.behave) = Box::new(f);
        }

        fn seen(&self) -> Vec<String> {
            lock(&self.seen).clone()
        }

        /// 取り込み日 imported_at の画像を足す。ハッシュはファイル名にも使う
        fn add(&self, hash: &str, imported_at: i64) {
            add(&self.lib, hash, imported_at);
        }

        fn set(&self, hash: &str, column: &str) {
            self.lib
                .with(|l| {
                    l.conn
                        .execute(
                            &format!("UPDATE images SET {column} = 1 WHERE hash = ?1"),
                            [hash],
                        )
                        .map_err(err)
                })
                .unwrap();
        }

        fn computed(&self) -> HashSet<String> {
            computed(&self.lib)
        }
    }

    fn add(lib: &Mutex<Option<Library>>, hash: &str, imported_at: i64) {
        lib.with(|l| {
            l.conn
                .execute(
                    "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                        imported_at, registered_at)
                     VALUES (?1, ?2, 1, 1, 1, 1, '#808080', ?3, 1)",
                    params![format!("{hash}.jpg"), hash, imported_at],
                )
                .map_err(err)
        })
        .unwrap();
    }

    fn computed(lib: &Mutex<Option<Library>>) -> HashSet<String> {
        lib.with(|l| l.with_features(|s| s.computed(&aspects())))
            .unwrap()
    }

    fn set<const N: usize>(hashes: [&str; N]) -> HashSet<String> {
        hashes.iter().map(|h| h.to_string()).collect()
    }

    fn strings<const N: usize>(hashes: [&str; N]) -> Vec<String> {
        hashes.iter().map(|h| h.to_string()).collect()
    }

    #[test]
    fn 未計算の画像を取り込み日の新しい順に計算して1枚ごとに保存する() {
        let r = rig();
        r.add("A", 1);
        r.add("C", 3);
        r.add("B", 2);
        let lib = r.lib.clone();
        let saved = Arc::new(Mutex::new(vec![]));
        let s = saved.clone();
        r.behave(move |_| {
            lock(&s).push(computed(&lib).len());
            good()
        });

        r.pass();

        assert_eq!(r.seen(), strings(["C", "B", "A"]));
        // 2枚目を計算するときには1枚目が保存されている
        assert_eq!(*lock(&saved), vec![0, 1, 2]);
        assert_eq!(r.computed(), set(["A", "B", "C"]));
        assert_eq!(
            r.calc.status(),
            Status {
                running: false,
                done: 3,
                total: 3,
                failed: 0,
                error: None
            }
        );
    }

    #[test]
    fn ゴミ箱と見つからない画像を計算しない() {
        let r = rig();
        r.add("A", 1);
        r.add("T", 2);
        r.add("M", 3);
        r.set("T", "deleted_at");
        r.set("M", "missing_at");

        r.pass();

        assert_eq!(r.seen(), strings(["A"]));
        assert_eq!(r.calc.status().total, 1);
    }

    #[test]
    fn 計算済みの画像を計算し直さない() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        r.pass();
        r.add("C", 3);

        r.pass();

        assert_eq!(r.seen(), strings(["B", "A", "C"]));
        assert_eq!(r.calc.status().done, 3);
    }

    #[test]
    fn 類似画像検索がoffならワーカーを起動せず状態が初期値になる() {
        let r = rig();
        r.add("A", 1);
        r.pass();
        r.enabled.store(false, Ordering::SeqCst);

        r.pass();

        assert_eq!(r.starts.load(Ordering::SeqCst), 1);
        assert_eq!(r.calc.status(), Status::default());
    }

    #[test]
    fn 未計算がなければワーカーを起動しない() {
        let r = rig();
        r.add("A", 1);
        r.pass();

        r.pass();

        assert_eq!(r.starts.load(Ordering::SeqCst), 1);
        assert_eq!(r.calc.status().done, 1);
        assert!(!r.calc.status().running);
    }

    #[test]
    fn ライブラリを開いていなければエラーにせず状態が初期値になる() {
        let r = rig();
        r.add("A", 1);
        r.pass();
        lock(&r.lib).take();

        r.pass();

        assert_eq!(r.calc.status(), Status::default());
    }

    #[test]
    fn 計算の途中でライブラリが閉じられるとエラーを入れずに抜ける() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        let (me, lib) = (r.me.clone(), r.lib.clone());
        r.behave(move |_| {
            me.get().unwrap().halt();
            lock(&lib).take();
            good()
        });

        r.pass();

        assert_eq!(r.seen(), strings(["B"]));
        assert_eq!(r.calc.status().error, None);
        assert!(!r.calc.status().running);
    }

    #[test]
    fn モデル名の違う行しかない画像を計算し直し古い行が消える() {
        let r = rig();
        r.add("A", 1);
        let old = [aspect("content", "m0", 2), aspect("composition", "c1", 3)];
        r.lib
            .with(|l| {
                l.with_features(|s| {
                    s.put(
                        "A",
                        &[(&old[0], &[1.0, 0.0]), (&old[1], &[1.0, 0.0, 0.0])],
                        1,
                    )
                })
            })
            .unwrap();

        r.pass();

        assert_eq!(r.seen(), strings(["A"]));
        let left = r
            .lib
            .with(|l| l.with_features(|s| s.load(&old[0])))
            .unwrap();
        assert!(left.is_empty());
    }

    #[test]
    fn kura_dbにない画像の行が計算を始める前に消える() {
        let r = rig();
        r.add("A", 1);
        let a = aspects();
        r.lib
            .with(|l| {
                l.with_features(|s| {
                    s.put("Z", &[(&a[0], &[1.0, 0.0]), (&a[1], &[1.0, 0.0, 0.0])], 1)
                })
            })
            .unwrap();
        let lib = r.lib.clone();
        let during = Arc::new(Mutex::new(HashSet::new()));
        let d = during.clone();
        r.behave(move |_| {
            *lock(&d) = computed(&lib);
            good()
        });

        r.pass();

        assert!(lock(&during).is_empty());
        assert_eq!(r.computed(), set(["A"]));
    }

    #[test]
    fn 計算できなかった画像を数えて次へ進み同じ起動の間は繰り返さない() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        r.behave(|h| match h {
            "B" => Err(Failure::Image("読めない".into())),
            _ => good(),
        });

        r.pass();
        r.pass();

        assert_eq!(r.seen(), strings(["B", "A"]));
        assert_eq!(r.computed(), set(["A"]));
        let s = r.calc.status();
        assert_eq!((s.done, s.failed, s.total, s.error), (1, 1, 2, None));
    }

    #[test]
    fn 再計算の後は失敗していた画像をもう一度計算する() {
        let r = rig();
        r.add("A", 1);
        r.behave(|_| Err(Failure::Image("読めない".into())));
        r.pass();
        r.behave(|_| good());

        r.calc.retry();
        r.pass();

        assert_eq!(r.seen(), strings(["A", "A"]));
        assert_eq!(r.computed(), set(["A"]));
        assert_eq!(r.calc.status().failed, 0);
    }

    #[test]
    fn ワーカーが落ちるとその画像を数えてエラーで止まり次の回は飛ばして続ける() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        r.add("C", 3);
        r.behave(|h| match h {
            "B" => Err(Failure::Dead("落ちた".into())),
            _ => good(),
        });

        r.pass();

        assert_eq!(r.seen(), strings(["C", "B"]));
        let s = r.calc.status();
        assert_eq!((s.done, s.failed), (1, 1));
        assert_eq!(s.error.as_deref(), Some(STOPPED));
        assert!(!s.running);

        r.pass();

        assert_eq!(r.seen(), strings(["C", "B", "A"]));
        assert_eq!(r.computed(), set(["A", "C"]));
        assert_eq!(r.calc.status().error, None);
        assert_eq!(r.starts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn ワーカーを起動できないとエラーで止まりどの画像も失敗に数えない() {
        let r = rig();
        r.add("A", 1);
        r.start_fails.store(true, Ordering::SeqCst);

        r.pass();

        let s = r.calc.status();
        assert_eq!(s.error.as_deref(), Some(STOPPED));
        assert_eq!((s.failed, s.done, s.total, s.running), (0, 0, 1, false));
        assert!(r.seen().is_empty());
    }

    #[test]
    fn 計算の途中で止められるとその画像を書かずに抜ける() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        let me = r.me.clone();
        r.behave(move |_| {
            me.get().unwrap().halt();
            good()
        });

        r.pass();

        assert_eq!(r.seen(), strings(["B"]));
        assert!(r.computed().is_empty());
        assert_eq!(r.calc.status().error, None);
    }

    #[test]
    fn 計算の途中でライブラリが入れ替わると前の結果を次のライブラリに書かない() {
        let r = rig();
        r.add("A", 1);
        let other = tempfile::tempdir().unwrap();
        let next = library::create(other.path()).unwrap();
        let slot = Arc::new(Mutex::new(Some(next)));
        let lib = r.lib.clone();
        let s = slot.clone();
        r.behave(move |_| {
            let next = lock(&s).take().unwrap();
            *lock(&lib) = Some(next);
            add(&lib, "A", 1);
            good()
        });

        r.pass();

        assert_eq!(r.seen(), strings(["A"]));
        assert!(r.computed().is_empty());
        assert_eq!(r.calc.status().error, None);
    }

    #[test]
    fn 計算の途中で完全削除された画像は書かず失敗にも数えない() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        let lib = r.lib.clone();
        r.behave(move |h| {
            lib.with(|l| {
                l.conn
                    .execute("DELETE FROM images WHERE hash = ?1", [h])
                    .map_err(err)
            })
            .unwrap();
            if h == "B" {
                Err(Failure::Image("サムネイルがない".into()))
            } else {
                good()
            }
        });

        r.pass();

        assert_eq!(r.seen(), strings(["B", "A"]));
        assert!(r.computed().is_empty());
        let s = r.calc.status();
        assert_eq!((s.failed, s.error), (0, None));
    }

    #[test]
    fn あるライブラリで失敗した画像も別のライブラリでは計算する() {
        let r = rig();
        r.add("A", 1);
        r.behave(|_| Err(Failure::Image("読めない".into())));
        r.pass();
        r.behave(|_| good());
        let other = tempfile::tempdir().unwrap();
        *lock(&r.lib) = Some(library::create(other.path()).unwrap());
        r.add("A", 1);

        r.pass();

        assert_eq!(r.seen(), strings(["A", "A"]));
        assert_eq!(r.computed(), set(["A"]));
    }

    #[test]
    fn 計算の途中でゴミ箱へ移された画像は保存する() {
        let r = rig();
        r.add("A", 1);
        let lib = r.lib.clone();
        r.behave(move |h| {
            lib.with(|l| {
                l.conn
                    .execute("UPDATE images SET deleted_at = 1 WHERE hash = ?1", [h])
                    .map_err(err)
            })
            .unwrap();
            good()
        });

        r.pass();

        assert_eq!(r.computed(), set(["A"]));
    }

    #[test]
    fn 保存に失敗するとエラーで止まり元の文を言い換える() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        r.behave(|_| Ok(vec![vec![1.0], vec![0.0, 1.0, 0.0]]));

        r.pass();

        assert_eq!(r.seen(), strings(["B"]));
        assert_eq!(r.calc.status().error.as_deref(), Some(UNSAVED));
    }

    #[test]
    fn ドライブを読めないときはその文のままエラーにする() {
        let r = rig();
        r.add("A", 1);
        // ライブラリはまだ features.db を開いていないので、開くときに権限で失敗する
        drop(crate::features::Store::open(r.dir.path(), false).unwrap());
        let file = crate::features::path(r.dir.path());
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();

        r.pass();

        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(r.calc.status().error.as_deref(), Some(DRIVE_UNREADABLE));
        assert!(r.seen().is_empty());
    }

    #[test]
    fn 状態が1枚ごとに合っている() {
        let r = rig();
        r.add("A", 1);
        r.add("B", 2);
        r.add("C", 3);
        r.add("T", 4);
        r.set("T", "deleted_at");
        let (me, lib) = (r.me.clone(), r.lib.clone());
        let checked = Arc::new(AtomicUsize::new(0));
        let n = checked.clone();
        r.behave(move |h| {
            let s = me.get().unwrap().status();
            let done = computed(&lib).len();
            // C の前は0枚、B の前は C だけ済み、A の前は B が失敗している
            let failed = usize::from(h == "A");
            assert_eq!(
                (s.done, s.failed, s.total, s.running),
                (done, failed, 3, true),
                "{h}"
            );
            n.fetch_add(1, Ordering::SeqCst);
            if h == "B" {
                Err(Failure::Image("読めない".into()))
            } else {
                good()
            }
        });

        r.pass();

        assert_eq!(checked.load(Ordering::SeqCst), 3);
        let s = r.calc.status();
        assert_eq!((s.done, s.failed, s.total), (2, 1, 3));
    }

    #[test]
    fn 回が終わるとワーカーを捨てる() {
        let r = rig();
        r.add("A", 1);

        r.pass();

        assert_eq!(r.drops.load(Ordering::SeqCst), 1);
    }

    fn wait_until(what: &str, f: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !f() {
            assert!(Instant::now() < end, "{what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn スレッドは合図で計算を始め終わると計算中でなくなる() {
        let r = rig_with(true);
        r.add("A", 1);
        r.add("B", 2);

        r.calc.wake();

        wait_until("2枚を計算する", || r.calc.status().done == 2);
        wait_until("計算中でなくなる", || !r.calc.status().running);
        assert_eq!(r.computed(), set(["A", "B"]));
    }

    #[test]
    fn スレッドは計算の途中の合図で今の回の後にもう1回まわす() {
        let r = rig_with(true);
        r.add("A", 1);
        let (me, lib) = (r.me.clone(), r.lib.clone());
        r.behave(move |h| {
            if h == "A" {
                add(&lib, "N", 2);
                me.get().unwrap().wake();
            }
            good()
        });

        r.calc.wake();

        wait_until("途中で足した画像も計算する", || {
            r.computed().contains("N")
        });
        assert_eq!(r.seen(), strings(["A", "N"]));
    }
}
