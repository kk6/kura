//! 閉じる・終了・切り替えの前に、各ウィンドウの未保存の変更（ボードの配置、入力中のメモ）の保存を待つ
//! （FR-704、FR-105、FR-711、FR-411）。変更は画面が持っているので、Rust は保存を頼んで結果を待つだけにする。
//! 遷移を決めるのは Rust の1か所にし、ウィンドウごとに勝手に閉じたり終了したりしない（spikes/board-native）

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

type Reply = Result<(), String>;

#[derive(Default)]
struct State {
    /// 保存の依頼を受け取れるウィンドウ。画面を読み込む前のウィンドウには、保存するものがない
    ready: HashSet<String>,
    next: u64,
    /// 依頼の id から、頼んだウィンドウのラベルと応答の送り先
    waiting: HashMap<u64, (String, Sender<Reply>)>,
    /// 待っている遷移があるか。2つの遷移を重ねると、片方の結果で他方を進めてしまうため1つずつにする
    busy: bool,
}

#[derive(Default, Clone)]
pub struct Settle(Arc<Mutex<State>>);

/// 1回分の保存待ち。drop すると次の遷移を受け付ける。遅れて届いた応答は捨てる
pub struct Round {
    state: Arc<Mutex<State>>,
    pub requests: Vec<(String, u64)>,
    rx: Receiver<Reply>,
}

impl Settle {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn ready(&self, label: &str) {
        self.lock().ready.insert(label.into());
    }

    pub fn gone(&self, label: &str) {
        self.lock().ready.remove(label);
    }

    /// labels のうち受け取れるウィンドウへの依頼を作る。ほかの遷移を待っている間は断る
    pub fn begin(&self, labels: &[&str]) -> Result<Round, String> {
        let mut guard = self.lock();
        let s = &mut *guard;
        if s.busy {
            return Err("保存を待っています。終わってからもう一度試してください".into());
        }
        s.busy = true;
        let (tx, rx) = mpsc::channel();
        let mut requests = vec![];
        for label in labels.iter().filter(|l| s.ready.contains(**l)) {
            s.next += 1;
            let id = s.next;
            s.waiting.insert(id, (label.to_string(), tx.clone()));
            requests.push((label.to_string(), id));
        }
        Ok(Round {
            state: self.0.clone(),
            requests,
            rx,
        })
    }

    /// 画面からの応答。待っていない id（遅れて届いた応答）と、頼んでいないウィンドウからの応答は捨てる。
    /// JS の listen は宛先に関係なくイベントを受けるので、別のウィンドウが代わりに答えて成功にしないため
    pub fn reply(&self, label: &str, id: u64, result: Reply) {
        let mut s = self.lock();
        if s.waiting.get(&id).is_none_or(|(asked, _)| asked != label) {
            log::warn!("頼んでいない保存の応答を捨てました：{label}、{id}");
            return;
        }
        log::info!("保存の応答：{label}、{result:?}");
        if let Some((_, tx)) = s.waiting.remove(&id) {
            // 受け手が先に終わっていても、遅れて届いた応答と同じく捨ててよい
            let _ = tx.send(result);
        }
    }
}

impl Round {
    /// すべての応答を待ち、最初の失敗を返す。期限までに応答がなければ失敗として遷移を止める
    pub fn wait(&self, timeout: Duration) -> Reply {
        let deadline = Instant::now() + timeout;
        let mut first = Ok(());
        for _ in &self.requests {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(r) => first = first.and(r),
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    return Err("ウィンドウの保存が終わりませんでした".into())
                }
            }
        }
        first
    }
}

impl Drop for Round {
    fn drop(&mut self) {
        let mut s = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        for (_, id) in &self.requests {
            s.waiting.remove(id);
        }
        s.busy = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT: Duration = Duration::from_millis(50);

    fn ready(labels: &[&str]) -> Settle {
        let s = Settle::default();
        labels.iter().for_each(|l| s.ready(l));
        s
    }

    #[test]
    fn すべてのウィンドウが保存できたら進める() {
        let s = ready(&["main", "board"]);
        let round = s.begin(&["board", "main"]).unwrap();
        for (label, id) in &round.requests {
            s.reply(label, *id, Ok(()));
        }
        assert_eq!(round.wait(SHORT), Ok(()));
    }

    #[test]
    fn ひとつでも保存できなければ遷移を止めてその理由を返す() {
        let s = ready(&["main", "board"]);
        let round = s.begin(&["board", "main"]).unwrap();
        s.reply(
            "board",
            round.requests[0].1,
            Err("ボードを保存できませんでした".into()),
        );
        s.reply("main", round.requests[1].1, Ok(()));
        assert_eq!(
            round.wait(SHORT),
            Err("ボードを保存できませんでした".into())
        );
    }

    #[test]
    fn 応答がなければ期限で失敗にする() {
        let s = ready(&["board"]);
        let round = s.begin(&["board"]).unwrap();
        assert!(round.wait(SHORT).is_err());
    }

    #[test]
    fn 画面を読み込む前や閉じた後のウィンドウには頼まない() {
        let s = ready(&["main", "board"]);
        s.gone("board");
        let round = s.begin(&["board", "main", "other"]).unwrap();
        assert_eq!(round.requests.len(), 1);
        assert_eq!(round.requests[0].0, "main");
    }

    #[test]
    fn 待っている間は次の遷移を断り終われば受け付ける() {
        let s = ready(&["board"]);
        let round = s.begin(&["board"]).unwrap();
        assert!(s.begin(&["board"]).is_err());
        drop(round);
        assert!(s.begin(&["board"]).is_ok());
    }

    #[test]
    fn 前の遷移へ遅れて届いた応答を次の遷移の結果にしない() {
        let s = ready(&["board"]);
        let old = s.begin(&["board"]).unwrap();
        let late = old.requests[0].1;
        drop(old);
        let round = s.begin(&["board"]).unwrap();
        s.reply("board", late, Ok(()));
        assert!(round.wait(SHORT).is_err());
    }

    #[test]
    fn 頼んだのと別のウィンドウの応答は受け取らない() {
        // JS の listen は宛先に関係なくイベントを受けるので、ギャラリーがボード宛ての依頼に答えることがある
        let s = ready(&["main", "board"]);
        let round = s.begin(&["board"]).unwrap();
        let id = round.requests[0].1;
        s.reply("main", id, Ok(()));
        s.reply("board", id, Err("ボードを保存できませんでした".into()));
        assert_eq!(
            round.wait(SHORT),
            Err("ボードを保存できませんでした".into())
        );
    }
}
