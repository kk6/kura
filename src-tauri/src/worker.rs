use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde::Deserialize;

use crate::manifest::{Aspect, Kind};

/// 1つの観点の計算の結果
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Vector(Vec<f32>),
    Pose(Pose),
}

/// ポーズの観点の結果。people は関節が足りる人物ごとの、長さ dim の配列。status が Ok のときだけ1人以上
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Pose {
    pub status: PoseStatus,
    pub people: Vec<Vec<f32>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PoseStatus {
    /// 人物の枠が1つもない
    None,
    /// 枠はあるが、関節が足りる人物がいない
    Few,
    /// 関節が足りる人物が1人以上
    Ok,
}

/// 何を起動するか。テストでは偽のワーカーを指す
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

/// 本体は ready 60秒、reply 30秒
pub struct Timeouts {
    pub ready: Duration,
    pub reply: Duration,
}

#[derive(Debug)]
pub enum Failure {
    /// その画像だけ計算できなかった。ワーカーは生きている
    Image(String),
    /// ワーカーが使えなくなった（落ちた、返事がない、決まりと違う行）。この Worker は捨てる
    Dead(String),
}

pub struct Worker {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next: u64,
    timeouts: Timeouts,
}

#[derive(Deserialize)]
struct Ready {
    ready: bool,
    protocol: Option<u32>,
    aspects: Option<Vec<ReadyAspect>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ReadyAspect {
    aspect: String,
    model: String,
    kind: Kind,
    dim: usize,
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
    ok: bool,
    features: Option<std::collections::HashMap<String, serde_json::Value>>,
    error: Option<String>,
}

/// やりとりの版。ready の観点の形と、要求の aspects が2で変わった
const PROTOCOL: u32 = 2;

/// 返事の1つの観点の値を、観点の決まりに照らして読む
fn value(a: &Aspect, raw: serde_json::Value) -> Result<Value, String> {
    let finite = |v: &[f32]| v.iter().all(|x| x.is_finite());
    match a.kind {
        Kind::Vector => {
            let v: Vec<f32> = serde_json::from_value(raw)
                .map_err(|e| format!("ワーカーの返した {} を読めません（{e}）", a.aspect))?;
            if v.len() != a.dim {
                return Err(format!(
                    "ワーカーの返した {} の長さが {} です（{} のはず）",
                    a.aspect,
                    v.len(),
                    a.dim
                ));
            }
            if !finite(&v) {
                return Err(format!(
                    "ワーカーの返した {} に有限でない値があります",
                    a.aspect
                ));
            }
            Ok(Value::Vector(v))
        }
        Kind::Pose => {
            let p: Pose = serde_json::from_value(raw)
                .map_err(|e| format!("ワーカーの返した {} を読めません（{e}）", a.aspect))?;
            if (p.status == PoseStatus::Ok) == p.people.is_empty() {
                return Err(format!(
                    "ワーカーの返した {} の状態と人数が合いません（{:?}、{}人）",
                    a.aspect,
                    p.status,
                    p.people.len()
                ));
            }
            if !p.people.iter().all(|x| x.len() == a.dim && finite(x)) {
                return Err(format!(
                    "ワーカーの返した {} の人の長さが {} でないか、有限でない値があります",
                    a.aspect, a.dim
                ));
            }
            Ok(Value::Pose(p))
        }
    }
}

impl Worker {
    /// expected の観点だけを読み込むよう --aspects を足して起動し、ready を待ち、aspects が expected と同じことを確かめる
    pub fn start(spec: &Spec, expected: &[Aspect], timeouts: Timeouts) -> Result<Worker, String> {
        let names: Vec<&str> = expected.iter().map(|a| a.aspect.as_str()).collect();
        let mut child = Command::new(&spec.program)
            .args(&spec.args)
            .arg("--aspects")
            .arg(names.join(","))
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
        if ready.protocol != Some(PROTOCOL) {
            return Err(format!(
                "ワーカーのやりとりの版が違います（{:?}）。アプリとワーカーの版が合っていません",
                ready.protocol
            ));
        }
        let same = ready.aspects.is_some_and(|got| {
            got.len() == expected.len()
                && got.iter().zip(expected).all(|(g, e)| {
                    g.aspect == e.aspect && g.model == e.model && g.kind == e.kind && g.dim == e.dim
                })
        });
        if !same {
            return Err(
                "ワーカーの観点が model.json と違います。アプリとワーカーの版が合っていません"
                    .into(),
            );
        }
        Ok(worker)
    }

    /// 1枚の aspects（start の expected の部分集合）を計算する。返り値は aspects と同じ順・同じ数
    pub fn compute(&mut self, thumb: &Path, aspects: &[Aspect]) -> Result<Vec<Value>, Failure> {
        let id = self.next;
        self.next += 1;
        // macOS のパスは UTF-8 なので、ここで止まるのはその画像だけの問題として扱う
        let path = thumb
            .to_str()
            .ok_or_else(|| Failure::Image(format!("パスを渡せません（{}）", thumb.display())))?;
        let names: Vec<&str> = aspects.iter().map(|a| a.aspect.as_str()).collect();
        let request = serde_json::json!({ "id": id, "path": path, "aspects": names }).to_string();
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
        aspects
            .iter()
            .map(|a| {
                let raw = features.remove(&a.aspect).ok_or_else(|| {
                    Failure::Dead(format!("ワーカーの返事に {} がありません", a.aspect))
                })?;
                value(a, raw).map_err(Failure::Dead)
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

    const READY: &str = r#"{"ready": true, "protocol": 2, "aspects": [{"aspect": "content", "model": "m1", "kind": "vector", "dim": 2}, {"aspect": "composition", "model": "m2", "kind": "vector", "dim": 3}]}"#;
    const OK: &str =
        r#"{"id": %d, "ok": true, "features": {"content": [0.6, 0.8], "composition": [1, 0, 0]}}"#;
    const READY_POSE: &str = r#"{"ready": true, "protocol": 2, "aspects": [{"aspect": "content", "model": "m1", "kind": "vector", "dim": 2}, {"aspect": "pose", "model": "p1", "kind": "pose", "dim": 3}]}"#;

    // 黙るワーカー。sleep だと kill されるのは sh だけで、sleep がパイプを持ったまま残る。
    // `exec cat >/dev/null` だと標準出力のパイプが閉じ、黙るのではなく終わったことになる
    const SILENT: &str = "exec cat 3>&1 >/dev/null";

    fn expected() -> Vec<Aspect> {
        use crate::features::tests::aspect;
        vec![aspect("content", "m1", 2), aspect("composition", "m2", 3)]
    }

    fn with_pose() -> Vec<Aspect> {
        use crate::features::tests::{aspect, pose_aspect};
        vec![aspect("content", "m1", 2), pose_aspect("p1", 3)]
    }

    fn vectors(v: Vec<Value>) -> Vec<Vec<f32>> {
        v.into_iter()
            .map(|x| match x {
                Value::Vector(v) => v,
                other => panic!("ベクトルでない：{other:?}"),
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

    fn dead_reason(r: Result<Vec<Value>, Failure>) -> String {
        match r {
            Err(Failure::Dead(e)) => e,
            other => panic!("Dead になっていない：{other:?}"),
        }
    }

    #[test]
    fn readyを受け取り要求と同じidの結果を受け取れる() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Worker::start(&replying(dir.path(), OK), &expected(), quick()).unwrap();

        let v = w.compute(Path::new("/tmp/a.jpg"), &expected()).unwrap();

        assert_eq!(vectors(v), vec![vec![0.6, 0.8], vec![1.0, 0.0, 0.0]]);
    }

    #[test]
    fn 続けて3件を要求し3件とも受け取れる() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = Worker::start(&replying(dir.path(), OK), &expected(), quick()).unwrap();

        for _ in 0..3 {
            assert!(w.compute(Path::new("/tmp/a.jpg"), &expected()).is_ok());
        }
    }

    #[test]
    fn ok_falseはimageになり次の要求を出せる() {
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            "echo '{READY}'\nn=0\nwhile read line; do n=$((n+1)); case $n in 1) printf '{{\"id\": %d, \"ok\": false, \"error\": \"読めません\"}}\\n' $n;; *) printf '{OK}\\n' $n;; esac; done"
        );
        let mut w = Worker::start(&fake(dir.path(), &body), &expected(), quick()).unwrap();

        match w.compute(Path::new("/tmp/broken.jpg"), &expected()) {
            Err(Failure::Image(e)) => assert_eq!(e, "読めません"),
            other => panic!("Image になっていない：{other:?}"),
        }
        assert!(w.compute(Path::new("/tmp/a.jpg"), &expected()).is_ok());
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
            READY.replace(r#""protocol": 2"#, r#""protocol": 1"#),
            READY.replace(
                r#""kind": "vector", "dim": 3"#,
                r#""kind": "pose", "dim": 3"#,
            ),
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
        dead_reason(w.compute(Path::new("/tmp/a.jpg"), &expected()));
    }

    #[test]
    fn 返事をしないワーカーは待ち切れたらcomputeがdeadになる() {
        let dir = tempfile::tempdir().unwrap();
        let spec = fake(dir.path(), &format!("echo '{READY}'\n{SILENT}"));
        let mut w = Worker::start(&spec, &expected(), quick()).unwrap();
        let t = Instant::now();

        dead_reason(w.compute(Path::new("/tmp/a.jpg"), &expected()));

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
            match w.compute(Path::new("/tmp/a.jpg"), &expected()) {
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

    #[test]
    fn 起動の引数にstartの観点をaspectsとして足す() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let spec = fake(
            dir.path(),
            &format!(
                "printf '%s\\n' \"$@\" > '{}'\necho '{READY_POSE}'\n{SILENT}",
                args.display()
            ),
        );
        let spec = Spec {
            args: [spec.args, vec!["--model-dir".into(), "/m".into()]].concat(),
            ..spec
        };

        let _w = Worker::start(&spec, &with_pose(), quick()).unwrap();

        assert_eq!(
            fs::read_to_string(&args).unwrap(),
            "--model-dir\n/m\n--aspects\ncontent,pose\n"
        );
    }

    #[test]
    fn 要求に観点を並べポーズの返事を受け取れる() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("requests");
        let reply = r#"{"id": %d, "ok": true, "features": {"pose": {"status": "ok", "people": [[0.1, 0.2, 0.9], [1, 2, 0.5]]}, "content": [9, 9, 9]}}"#;
        let spec = fake(
            dir.path(),
            &format!(
                "echo '{READY_POSE}'\nn=0\nwhile read line; do echo \"$line\" >> '{}'; n=$((n+1)); printf '{reply}\\n' $n; done",
                log.display()
            ),
        );
        let mut w = Worker::start(&spec, &with_pose(), quick()).unwrap();

        let v = w
            .compute(Path::new("/tmp/a.jpg"), &with_pose()[1..])
            .unwrap();

        assert_eq!(
            v,
            [Value::Pose(Pose {
                status: PoseStatus::Ok,
                people: vec![vec![0.1, 0.2, 0.9], vec![1.0, 2.0, 0.5]],
            })]
        );
        let sent: serde_json::Value =
            serde_json::from_str(fs::read_to_string(&log).unwrap().trim()).unwrap();
        assert_eq!(sent["aspects"], serde_json::json!(["pose"]));
        assert_eq!(sent["path"], "/tmp/a.jpg");
    }

    #[test]
    fn 人物なしと関節が足りないを受け取れる() {
        for (status, want) in [("none", PoseStatus::None), ("few", PoseStatus::Few)] {
            let dir = tempfile::tempdir().unwrap();
            let reply = format!(
                r#"{{"id": %d, "ok": true, "features": {{"pose": {{"status": "{status}", "people": []}}}}}}"#
            );
            let spec = fake(
                dir.path(),
                &format!("echo '{READY_POSE}'\nn=0\nwhile read line; do n=$((n+1)); printf '{reply}\\n' $n; done"),
            );
            let mut w = Worker::start(&spec, &with_pose(), quick()).unwrap();

            let v = w
                .compute(Path::new("/tmp/a.jpg"), &with_pose()[1..])
                .unwrap();

            assert_eq!(
                v,
                [Value::Pose(Pose {
                    status: want,
                    people: vec![]
                })]
            );
        }
    }

    #[test]
    fn 決まりと違うポーズの返事でcomputeがdeadになる() {
        let wrong = [
            ("観点がない", r#"{"content": [1, 0]}"#),
            (
                "知らない状態",
                r#"{"pose": {"status": "many", "people": []}}"#,
            ),
            ("ok で0人", r#"{"pose": {"status": "ok", "people": []}}"#),
            (
                "none で人がいる",
                r#"{"pose": {"status": "none", "people": [[1, 2, 3]]}}"#,
            ),
            (
                "few で人がいる",
                r#"{"pose": {"status": "few", "people": [[1, 2, 3]]}}"#,
            ),
            (
                "人の長さが違う",
                r#"{"pose": {"status": "ok", "people": [[1, 2]]}}"#,
            ),
            (
                "有限でない値",
                r#"{"pose": {"status": "ok", "people": [[1, 2, 1e39]]}}"#,
            ),
            ("ベクトルで返す", r#"{"pose": [1, 2, 3]}"#),
        ];
        for (name, features) in wrong {
            let dir = tempfile::tempdir().unwrap();
            let reply = format!(r#"{{"id": %d, "ok": true, "features": {features}}}"#);
            let spec = fake(
                dir.path(),
                &format!("echo '{READY_POSE}'\nn=0\nwhile read line; do n=$((n+1)); printf '{reply}\\n' $n; done"),
            );
            let mut w = Worker::start(&spec, &with_pose(), quick()).unwrap();
            match w.compute(Path::new("/tmp/a.jpg"), &with_pose()[1..]) {
                Err(Failure::Dead(_)) => {}
                other => panic!("{name}：Dead になっていない：{other:?}"),
            }
        }
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
        // 形と有限の値は compute が確かめる
        let v = w.compute(&thumb, &expected).unwrap();

        assert_eq!(v.len(), expected.len());
    }
}
