use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde::Deserialize;

use crate::manifest::Aspect;

/// 何を起動するか。テストでは偽のワーカーを指す
// タスク5の calc が main.rs の worker_spec で作り、Worker::start に渡す
#[allow(dead_code)]
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

/// 本体は ready 60秒、reply 30秒
// タスク5の calc が使う
#[allow(dead_code)]
pub struct Timeouts {
    pub ready: Duration,
    pub reply: Duration,
}

#[derive(Debug)]
// タスク5の calc が使う
#[allow(dead_code)]
pub enum Failure {
    /// その画像だけ計算できなかった。ワーカーは生きている
    Image(String),
    /// ワーカーが使えなくなった（落ちた、返事がない、決まりと違う行）。この Worker は捨てる
    Dead(String),
}

// タスク5の calc が使う
#[allow(dead_code)]
pub struct Worker {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next: u64,
    aspects: Vec<Aspect>,
    timeouts: Timeouts,
}

#[derive(Deserialize)]
// タスク5の calc が使う Worker が読む
#[allow(dead_code)]
struct Ready {
    ready: bool,
    protocol: Option<u32>,
    aspects: Option<Vec<ReadyAspect>>,
    error: Option<String>,
}

#[derive(Deserialize)]
// タスク5の calc が使う Worker が読む
#[allow(dead_code)]
struct ReadyAspect {
    aspect: String,
    model: String,
    dim: usize,
}

#[derive(Deserialize)]
// タスク5の calc が使う Worker が読む
#[allow(dead_code)]
struct Reply {
    id: u64,
    ok: bool,
    features: Option<std::collections::HashMap<String, Vec<f32>>>,
    error: Option<String>,
}

// タスク5の calc が使う
#[allow(dead_code)]
impl Worker {
    /// 起動して ready を待ち、aspects が expected と同じことを確かめる
    pub fn start(spec: &Spec, expected: &[Aspect], timeouts: Timeouts) -> Result<Worker, String> {
        let mut child = Command::new(&spec.program)
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "ワーカーを起動できません（{}：{e}）",
                    spec.program.display()
                )
            })?;
        let stdin = child.stdin.take().expect("stdin は pipe");
        let stdout = child.stdout.take().expect("stdout は pipe");
        let stderr = child.stderr.take().expect("stderr は pipe");
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("ワーカー：{line}");
            }
        });
        // ここから先の Err は、worker の drop でプロセスを kill して wait してから返る
        let worker = Worker {
            child,
            stdin,
            lines,
            next: 1,
            aspects: expected.to_vec(),
            timeouts,
        };
        let line = match worker.lines.recv_timeout(worker.timeouts.ready) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "ワーカーが {} 秒待っても準備できません",
                    worker.timeouts.ready.as_secs()
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("ワーカーが準備の前に終了しました".into())
            }
        };
        let ready: Ready = serde_json::from_str(&line)
            .map_err(|e| format!("ワーカーの準備の行を読めません（{e}）"))?;
        if !ready.ready {
            return Err(ready
                .error
                .unwrap_or_else(|| "ワーカーが準備できません".into()));
        }
        if ready.protocol != Some(1) {
            return Err(format!(
                "ワーカーのやりとりの版が違います（{:?}）。アプリとワーカーの版が合っていません",
                ready.protocol
            ));
        }
        let same = ready.aspects.is_some_and(|got| {
            got.len() == expected.len()
                && got
                    .iter()
                    .zip(expected)
                    .all(|(g, e)| g.aspect == e.aspect && g.model == e.model && g.dim == e.dim)
        });
        if !same {
            return Err(
                "ワーカーの観点が model.json と違います。アプリとワーカーの版が合っていません"
                    .into(),
            );
        }
        Ok(worker)
    }

    /// 1枚を計算する。返り値は expected と同じ順・同じ数のベクトル
    pub fn compute(&mut self, thumb: &Path) -> Result<Vec<Vec<f32>>, Failure> {
        let id = self.next;
        self.next += 1;
        // macOS のパスは UTF-8 なので、ここで止まるのはその画像だけの問題として扱う
        let path = thumb
            .to_str()
            .ok_or_else(|| Failure::Image(format!("パスを渡せません（{}）", thumb.display())))?;
        let request = serde_json::json!({ "id": id, "path": path }).to_string();
        writeln!(self.stdin, "{request}")
            .and_then(|()| self.stdin.flush())
            .map_err(|e| Failure::Dead(format!("ワーカーに要求を書けません（{e}）")))?;
        let line = match self.lines.recv_timeout(self.timeouts.reply) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => {
                return Err(Failure::Dead(format!(
                    "ワーカーが {} 秒待っても返事をしません",
                    self.timeouts.reply.as_secs()
                )))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(Failure::Dead("ワーカーが返事の前に終了しました".into()))
            }
        };
        let reply: Reply = serde_json::from_str(&line)
            .map_err(|e| Failure::Dead(format!("ワーカーの返事を読めません（{e}）")))?;
        if reply.id != id {
            return Err(Failure::Dead(format!(
                "ワーカーの返事の id が違います（{id} に {}）",
                reply.id
            )));
        }
        if !reply.ok {
            return Err(Failure::Image(reply.error.unwrap_or_default()));
        }
        let mut features = reply.features.unwrap_or_default();
        self.aspects
            .iter()
            .map(|a| {
                let v = features.remove(&a.aspect).ok_or_else(|| {
                    Failure::Dead(format!("ワーカーの返事に {} がありません", a.aspect))
                })?;
                if v.len() != a.dim {
                    return Err(Failure::Dead(format!(
                        "ワーカーの返した {} の長さが {} です（{} のはず）",
                        a.aspect,
                        v.len(),
                        a.dim
                    )));
                }
                if !v.iter().all(|x| x.is_finite()) {
                    return Err(Failure::Dead(format!(
                        "ワーカーの返した {} に有限でない値があります",
                        a.aspect
                    )));
                }
                Ok(v)
            })
            .collect()
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // 終わっていれば kill は失敗するが、どちらでも wait で後片付けする。読むスレッドは join しない
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;

    const READY: &str = r#"{"ready": true, "protocol": 1, "aspects": [{"aspect": "content", "model": "m1", "dim": 2}, {"aspect": "composition", "model": "m2", "dim": 3}]}"#;
    const OK: &str =
        r#"{"id": %d, "ok": true, "features": {"content": [0.6, 0.8], "composition": [1, 0, 0]}}"#;

    // 黙るワーカー。sleep だと kill されるのは sh だけで、sleep がパイプを持ったまま残る。
    // `exec cat >/dev/null` だと標準出力のパイプが閉じ、黙るのではなく終わったことになる
    const SILENT: &str = "exec cat 3>&1 >/dev/null";

    fn expected() -> Vec<Aspect> {
        [("content", "m1", 2), ("composition", "m2", 3)]
            .into_iter()
            .map(|(a, m, d)| Aspect {
                aspect: a.into(),
                model: m.into(),
                dim: d,
                file: None,
            })
            .collect()
    }

    fn quick() -> Timeouts {
        Timeouts {
            ready: Duration::from_millis(500),
            reply: Duration::from_millis(500),
        }
    }

    /// 偽のワーカー。最初に自分の pid を dir/pid に残す
    fn fake(dir: &Path, body: &str) -> Spec {
        let script = dir.join("worker.sh");
        let pid = dir.join("pid");
        fs::write(&script, format!("echo $$ > '{}'\n{body}\n", pid.display())).unwrap();
        Spec {
            program: "/bin/sh".into(),
            args: vec![script.into()],
        }
    }

    /// 要求ごとに reply（%d に要求の番号が入る printf の書式）を返すワーカー
    fn replying(dir: &Path, reply: &str) -> Spec {
        fake(
            dir,
            &format!(
                "echo '{READY}'\nn=0\nwhile read line; do n=$((n+1)); printf '{reply}\\n' $n; done"
            ),
        )
    }

    fn alive(dir: &Path) -> bool {
        let pid: i32 = fs::read_to_string(dir.join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: シグナル0は送らずに、プロセスがあるかだけを確かめる
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn dead_reason(r: Result<Vec<Vec<f32>>, Failure>) -> String {
        match r {
            Err(Failure::Dead(e)) => e,
            other => panic!("Dead になっていない：{other:?}"),
        }
    }

    #[test]
    fn readyを受け取り要求と同じidの結果を受け取れる() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Worker::start(&replying(dir.path(), OK), &expected(), quick()).unwrap();

        let v = w.compute(Path::new("/tmp/a.jpg")).unwrap();

        assert_eq!(v, vec![vec![0.6, 0.8], vec![1.0, 0.0, 0.0]]);
    }

    #[test]
    fn 続けて3件を要求し3件とも受け取れる() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Worker::start(&replying(dir.path(), OK), &expected(), quick()).unwrap();

        for _ in 0..3 {
            assert!(w.compute(Path::new("/tmp/a.jpg")).is_ok());
        }
    }

    #[test]
    fn ok_falseはimageになり次の要求を出せる() {
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            "echo '{READY}'\nn=0\nwhile read line; do n=$((n+1)); case $n in 1) printf '{{\"id\": %d, \"ok\": false, \"error\": \"読めません\"}}\\n' $n;; *) printf '{OK}\\n' $n;; esac; done"
        );
        let mut w = Worker::start(&fake(dir.path(), &body), &expected(), quick()).unwrap();

        match w.compute(Path::new("/tmp/broken.jpg")) {
            Err(Failure::Image(e)) => assert_eq!(e, "読めません"),
            other => panic!("Image になっていない：{other:?}"),
        }
        assert!(w.compute(Path::new("/tmp/a.jpg")).is_ok());
    }

    #[test]
    fn programがないとstartがerrになる() {
        let dir = tempfile::tempdir().unwrap();
        let spec = Spec {
            program: dir.path().join("ない"),
            args: vec![],
        };
        assert!(Worker::start(&spec, &expected(), quick()).is_err());
    }

    #[test]
    fn ready_falseのerrorがstartのerrに入る() {
        let dir = tempfile::tempdir().unwrap();
        let spec = fake(
            dir.path(),
            r#"echo '{"ready": false, "error": "モデルがありません"}'; exit 1"#,
        );
        let e = Worker::start(&spec, &expected(), quick()).err().unwrap();
        assert!(e.contains("モデルがありません"), "{e}");
        assert!(!alive(dir.path()));
    }

    #[test]
    fn readyを出さずに終わるワーカーでstartがerrになる() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Worker::start(&fake(dir.path(), "exit 0"), &expected(), quick()).is_err());
    }

    #[test]
    fn readyを出さずに黙るワーカーは待ち切れたらerrになりプロセスが残らない() {
        let dir = tempfile::tempdir().unwrap();
        let spec = fake(dir.path(), SILENT);
        let t = Instant::now();

        assert!(Worker::start(&spec, &expected(), quick()).is_err());

        assert!(t.elapsed() >= quick().ready);
        assert!(!alive(dir.path()));
    }

    #[test]
    fn aspectsやprotocolがexpectedと違うとstartがerrになる() {
        let wrong = [
            READY.replace(r#""m1""#, r#""m9""#),
            READY.replace(r#""dim": 3"#, r#""dim": 4"#),
            READY.replace(r#""protocol": 1"#, r#""protocol": 2"#),
        ];
        for ready in wrong {
            let dir = tempfile::tempdir().unwrap();
            let spec = fake(dir.path(), &format!("echo '{ready}'\n{SILENT}"));
            assert!(
                Worker::start(&spec, &expected(), quick()).is_err(),
                "{ready}"
            );
            assert!(!alive(dir.path()), "{ready}");
        }
    }

    #[test]
    fn 要求の後に終わるワーカーでcomputeがdeadになる() {
        let dir = tempfile::tempdir().unwrap();
        let spec = fake(dir.path(), &format!("echo '{READY}'\nread line\nexit 0"));
        let mut w = Worker::start(&spec, &expected(), quick()).unwrap();
        dead_reason(w.compute(Path::new("/tmp/a.jpg")));
    }

    #[test]
    fn 返事をしないワーカーは待ち切れたらcomputeがdeadになる() {
        let dir = tempfile::tempdir().unwrap();
        let spec = fake(dir.path(), &format!("echo '{READY}'\n{SILENT}"));
        let mut w = Worker::start(&spec, &expected(), quick()).unwrap();
        let t = Instant::now();

        dead_reason(w.compute(Path::new("/tmp/a.jpg")));

        assert!(t.elapsed() >= quick().reply);
    }

    #[test]
    fn 決まりと違う返事でcomputeがdeadになる() {
        let wrong = [
            ("壊れた行", "{\"id\": %d, "),
            (
                "違う id",
                r#"{"id": 99, "ok": true, "features": {"content": [0.6, 0.8], "composition": [1, 0, 0]}}"#,
            ),
            (
                "足りない観点",
                r#"{"id": %d, "ok": true, "features": {"content": [0.6, 0.8]}}"#,
            ),
            (
                "違う長さ",
                r#"{"id": %d, "ok": true, "features": {"content": [0.6, 0.8], "composition": [1, 0]}}"#,
            ),
            (
                "有限でない値",
                r#"{"id": %d, "ok": true, "features": {"content": [0.6, 1e39], "composition": [1, 0, 0]}}"#,
            ),
        ];
        for (name, reply) in wrong {
            let dir = tempfile::tempdir().unwrap();
            let mut w = Worker::start(&replying(dir.path(), reply), &expected(), quick()).unwrap();
            match w.compute(Path::new("/tmp/a.jpg")) {
                Err(Failure::Dead(_)) => {}
                other => panic!("{name}：Dead になっていない：{other:?}"),
            }
        }
    }

    #[test]
    fn workerをdropするとプロセスが残らない() {
        let dir = tempfile::tempdir().unwrap();
        let w = Worker::start(&replying(dir.path(), OK), &expected(), quick()).unwrap();
        assert!(alive(dir.path()));

        drop(w);

        assert!(!alive(dir.path()));
    }

    /// 同梱したワーカー（本物のモデル）で1枚を計算する。リリース用ビルドの .app の中身を渡して流す。
    /// KURA_WORKER（実行ファイル）、KURA_MANIFEST（model.json）、KURA_MODEL_DIR（モデルのフォルダ）
    #[test]
    #[ignore]
    fn 同梱したワーカーで1枚を計算する() {
        let var = |name: &str| {
            std::env::var_os(name).unwrap_or_else(|| panic!("環境変数 {name} がありません"))
        };
        let (program, manifest, models) = (
            var("KURA_WORKER"),
            var("KURA_MANIFEST"),
            var("KURA_MODEL_DIR"),
        );
        let expected = crate::manifest::read(Path::new(&manifest)).unwrap().aspects;
        let spec = Spec {
            program: program.into(),
            args: vec!["--manifest".into(), manifest, "--model-dir".into(), models],
        };
        let dir = tempfile::tempdir().unwrap();
        let thumb = dir.path().join("a.jpg");
        image::RgbImage::from_fn(320, 240, |x, y| image::Rgb([x as u8, y as u8, 128]))
            .save(&thumb)
            .unwrap();
        let timeouts = Timeouts {
            ready: Duration::from_secs(60),
            reply: Duration::from_secs(30),
        };

        let mut w = Worker::start(&spec, &expected, timeouts).unwrap();
        let v = w.compute(&thumb).unwrap();

        assert_eq!(v.len(), expected.len());
        for (a, x) in expected.iter().zip(&v) {
            assert_eq!(x.len(), a.dim, "{}", a.aspect);
            assert!(x.iter().all(|f| f.is_finite()), "{}", a.aspect);
        }
    }
}
