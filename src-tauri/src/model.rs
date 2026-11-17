use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::manifest::{Aspect, Manifest, ModelFile};

/// すべての観点のモデルのファイル。学習済みモデルを使わない観点の分はない
pub fn files(manifest: &Manifest) -> Vec<&ModelFile> {
    manifest.aspects.iter().flat_map(|a| &a.files).collect()
}

/// ON にする前の確認で見せる大きさ（バイト）
pub fn size(manifest: &Manifest) -> u64 {
    files(manifest).into_iter().map(download_size).sum()
}

/// ダウンロードする大きさ。zip から取り出すファイルは zip の大きさ
fn download_size(file: &ModelFile) -> u64 {
    file.archive.as_ref().map_or(file.size, |a| a.size)
}

/// その観点のモデルのファイルがすべて dir にある。SHA-256 は計算しない（置くときに確かめている）
pub fn available(dir: &Path, aspect: &Aspect) -> bool {
    aspect.files.iter().all(|f| dir.join(&f.name).is_file())
}

/// モデルのファイルが欠けている観点（model.json の並び）と、欠けたファイルのダウンロードの大きさの合計
#[derive(Debug, PartialEq, Serialize)]
pub struct Missing {
    pub aspects: Vec<String>,
    pub size: u64,
}

/// 通信せずに、dir に欠けているモデルを調べる
pub fn missing(manifest: &Manifest, dir: &Path) -> Missing {
    let gone: Vec<&Aspect> = manifest
        .aspects
        .iter()
        .filter(|a| !available(dir, a))
        .collect();
    Missing {
        aspects: gone.iter().map(|a| a.aspect.clone()).collect(),
        size: gone
            .iter()
            .flat_map(|a| &a.files)
            .filter(|f| !dir.join(&f.name).is_file())
            .map(download_size)
            .sum(),
    }
}

/// 2つの画面の操作が同じ .part に同時に書かないよう、ダウンロードを1つずつにする
static FETCHING: Mutex<()> = Mutex::new(());

/// dir の下に files をそろえる。SHA-256 が合うファイルはそのまま使い、通信しない（NFR-09）。
/// 足りないか中身の違うファイルだけをダウンロードする。progress(済んだバイト数, 全体のバイト数)
pub fn prepare(
    dir: &Path,
    files: &[&ModelFile],
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let _fetching = FETCHING.lock().unwrap_or_else(PoisonError::into_inner);
    let total = files.iter().map(|f| download_size(f)).sum();
    let mut done = 0;
    for file in files {
        if !matches(&dir.join(&file.name), &file.sha256) {
            fs::create_dir_all(dir).map_err(|e| format!("モデルの置き場所を作れません（{e}）"))?;
            fetch(&file.url, dir, file, |bytes| progress(done + bytes, total))?;
        }
        done += download_size(file);
    }
    Ok(())
}

/// url を dir/<名前>.part に書き、SHA-256 が合えば dir/<名前> に置き換える。
/// archive があれば、url の zip を dir/<名前>.zip.part に書いて確かめ、member を <名前>.part に取り出す。
/// 失敗しても成功しても .zip.part と .part を残さない。
/// 置き換えるまで前のファイルに触らないので、途中で切れても前のファイルは残る
pub fn fetch(
    url: &str,
    dir: &Path,
    file: &ModelFile,
    progress: impl FnMut(u64),
) -> Result<(), String> {
    let part = dir.join(format!("{}.part", file.name));
    let zip = dir.join(format!("{}.zip.part", file.name));
    let r = match &file.archive {
        None => download(url, &part, progress),
        Some(a) => download(url, &zip, progress)
            .and_then(|()| verify(&zip, &a.sha256, url))
            .and_then(|()| extract(&zip, &a.member, &part)),
    }
    .and_then(|()| verify(&part, &file.sha256, url))
    .and_then(|()| {
        fs::rename(&part, dir.join(&file.name)).map_err(|e| format!("モデルを置けません（{e}）"))
    });
    for p in [&zip, &part] {
        if p.exists() {
            if let Err(e) = fs::remove_file(p) {
                log::error!("書きかけのモデルを消せません：{}：{e}", p.display());
            }
        }
    }
    r
}

fn verify(path: &Path, sha256: &str, url: &str) -> Result<(), String> {
    if matches(path, sha256) {
        return Ok(());
    }
    log::error!(
        "ダウンロードしたモデルの SHA-256 が違います：{url}：{}",
        path.display()
    );
    Err("ダウンロードしたモデルの中身が正しくありません".into())
}

// zip のクレートを足さないため、macOS に入っている unzip を使う（curl と同じ理由）
const UNZIP: &str = "/usr/bin/unzip";

/// zip の member を part に書き出す
fn extract(zip: &Path, member: &str, part: &Path) -> Result<(), String> {
    let out = fs::File::create(part).map_err(|e| format!("モデルを置けません（{e}）"))?;
    let r = Command::new(UNZIP)
        .arg("-p")
        .arg(zip)
        .arg(member)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("モデルを取り出せません（{UNZIP} を起動できません：{e}）"))?;
    if r.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&r.stderr);
    let stderr = stderr.trim();
    log::error!(
        "モデルを取り出せません：{}：{member}：{}：{stderr}",
        zip.display(),
        r.status
    );
    Err(format!(
        "ダウンロードしたモデルを取り出せません（{stderr}）"
    ))
}

// HTTP のクレートを足さないため、macOS に入っている curl を使う
const CURL: &str = "/usr/bin/curl";

// 止まった通信でエラーと「再試行」を出すため。30秒つながらないか、毎秒1KB未満が60秒続いたら失敗にする。
// 全体の時間（--max-time）では打ち切らない。遅い回線でも進んでいる間は止めない
const STALL: [&str; 6] = [
    "--connect-timeout",
    "30",
    "--speed-limit",
    "1024",
    "--speed-time",
    "60",
];

/// url を part に書く curl のコマンド
fn curl(url: &str, part: &Path) -> Command {
    let mut c = Command::new(CURL);
    c.args(["-f", "-L", "-sS"])
        .args(STALL)
        .arg("--output")
        .arg(part)
        .arg(url);
    c
}

/// curl で url を part に書く。動いている間、part の大きさを progress に渡す
fn download(url: &str, part: &Path, mut progress: impl FnMut(u64)) -> Result<(), String> {
    // 通信したことを後から確かめられるよう、通信の前に必ず残す（NFR-08）
    log::info!("モデルをダウンロードします：{url}");
    let mut child = curl(url, part)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("モデルをダウンロードできません（{CURL} を起動できません：{e}）"))?;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        progress(fs::metadata(part).map(|m| m.len()).unwrap_or(0));
        thread::sleep(Duration::from_millis(200));
    };
    if status.success() {
        progress(fs::metadata(part).map(|m| m.len()).unwrap_or(0));
        return Ok(());
    }
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    let stderr = stderr.trim();
    log::error!("モデルをダウンロードできません：{url}：{status}：{stderr}");
    Err(format!("モデルをダウンロードできません（{stderr}）"))
}

/// path があり、中身の SHA-256 が sha256 と同じ
fn matches(path: &Path, sha256: &str) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0; 1 << 20];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) => {
                log::warn!("モデルを読めません：{}：{e}", path.display());
                return false;
            }
        }
    }
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    hex.eq_ignore_ascii_case(sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const BODY: &[u8] = b"fake onnx model";

    fn model(name: &str, url: &str, body: &[u8]) -> ModelFile {
        ModelFile {
            name: name.into(),
            url: url.into(),
            sha256: crate::import::sha256(body),
            size: body.len() as u64,
            archive: None,
        }
    }

    const MEMBER: &str = "20230928/onnx/end2end.onnx";

    /// 配布元に見立てたフォルダに、MEMBER に body を入れた zip を置く。返り値は file:// の URL と zip の中身
    fn serve_zip(dir: &Path, body: &[u8]) -> (String, Vec<u8>) {
        let src = dir.join("src");
        let inner = src.join(MEMBER);
        fs::create_dir_all(inner.parent().unwrap()).unwrap();
        fs::write(&inner, body).unwrap();
        fs::write(src.join("20230928/onnx/pipeline.json"), b"{}").unwrap();
        let zip = dir.join("served.zip");
        let ok = Command::new("/usr/bin/zip")
            .current_dir(&src)
            .args(["-q", "-r"])
            .arg(&zip)
            .arg("20230928")
            .status()
            .unwrap()
            .success();
        assert!(ok);
        (format!("file://{}", zip.display()), fs::read(&zip).unwrap())
    }

    /// zip から取り出すファイル。body は取り出した中身、zip は配る zip
    fn zipped(name: &str, url: &str, body: &[u8], zip: &[u8]) -> ModelFile {
        ModelFile {
            archive: Some(crate::manifest::Archive {
                member: MEMBER.into(),
                sha256: crate::import::sha256(zip),
                size: zip.len() as u64,
            }),
            ..model(name, url, body)
        }
    }

    /// dir に name のほか何も残っていない（.zip.part も .part もない）
    fn only(dir: &Path, names: &[&str]) {
        let mut left: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, names);
    }

    #[test]
    fn zipから取り出して置き進み具合はzipの大きさで数える() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, zip) = serve_zip(tmp.path(), BODY);
        let dir = tmp.path().join("models");
        let file = zipped("det.onnx", &url, BODY, &zip);
        let mut seen = Vec::new();

        prepare(&dir, &[&file], |done, total| seen.push((done, total))).unwrap();

        assert_eq!(fs::read(dir.join("det.onnx")).unwrap(), BODY);
        only(&dir, &["det.onnx"]);
        let n = zip.len() as u64;
        assert_eq!(seen.last(), Some(&(n, n)));
    }

    #[test]
    fn zipの中身が正しくないと失敗し何も残らず前からあったファイルを壊さない() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, zip) = serve_zip(tmp.path(), BODY);
        let wrong = [
            // zip の SHA-256 が違う
            ModelFile {
                archive: Some(crate::manifest::Archive {
                    member: MEMBER.into(),
                    sha256: crate::import::sha256(b"other"),
                    size: zip.len() as u64,
                }),
                ..model("det.onnx", &url, BODY)
            },
            // member がない
            ModelFile {
                archive: Some(crate::manifest::Archive {
                    member: "none/end2end.onnx".into(),
                    sha256: crate::import::sha256(&zip),
                    size: zip.len() as u64,
                }),
                ..model("det.onnx", &url, BODY)
            },
            // 取り出した中身の SHA-256 が違う
            zipped("det.onnx", &url, b"another model", &zip),
        ];
        for (i, file) in wrong.iter().enumerate() {
            let dir = tmp.path().join(format!("models{i}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("det.onnx"), b"old").unwrap();

            assert!(fetch(&url, &dir, file, |_| {}).is_err(), "{i}");

            assert_eq!(fs::read(dir.join("det.onnx")).unwrap(), b"old", "{i}");
            only(&dir, &["det.onnx"]);

            fs::remove_file(dir.join("det.onnx")).unwrap();
            assert!(prepare(&dir, &[file], |_, _| {}).is_err(), "{i}");
            only(&dir, &[]);
        }
    }

    #[test]
    fn 大きさはzipがあればzipの大きさで数える() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest = Manifest {
            threads: 1,
            aspects: vec![
                crate::manifest::Aspect {
                    files: vec![model("v.onnx", "u", &[0; 10])],
                    ..crate::features::tests::aspect("content", "m", 2)
                },
                crate::features::tests::aspect("composition", "c", 2),
                crate::manifest::Aspect {
                    kind: crate::manifest::Kind::Pose,
                    files: vec![
                        zipped("det.onnx", "u", &[0; 100], &[0; 7]),
                        zipped("pose.onnx", "u", &[0; 100], &[0; 5]),
                    ],
                    ..crate::features::tests::aspect("pose", "p", 51)
                },
            ],
        };
        assert_eq!(size(&manifest), 22);

        let dir = tmp.path();
        fs::write(dir.join("v.onnx"), b"x").unwrap();
        fs::write(dir.join("det.onnx"), b"x").unwrap();
        assert_eq!(
            missing(&manifest, dir),
            Missing {
                aspects: vec!["pose".into()],
                size: 5
            }
        );
        assert!(!available(dir, &manifest.aspects[2]));
        assert!(available(dir, &manifest.aspects[1]));

        fs::write(dir.join("pose.onnx"), b"x").unwrap();
        assert_eq!(
            missing(&manifest, dir),
            Missing {
                aspects: vec![],
                size: 0
            }
        );
        fs::remove_file(dir.join("v.onnx")).unwrap();
        assert_eq!(missing(&manifest, dir).aspects, ["content"]);
    }

    /// 配布元に見立てたフォルダに body を置き、その file:// の URL を返す
    fn serve(dir: &Path, body: &[u8]) -> String {
        let src = dir.join("served.onnx");
        fs::write(&src, body).unwrap();
        format!("file://{}", src.display())
    }

    #[test]
    fn ダウンロードするとファイルができsha256が合う() {
        let tmp = tempfile::tempdir().unwrap();
        let url = serve(tmp.path(), BODY);
        let dir = tmp.path().join("models");
        let file = model("vision.onnx", &url, BODY);
        let mut seen = Vec::new();

        prepare(&dir, &[&file], |done, total| seen.push((done, total))).unwrap();

        assert_eq!(fs::read(dir.join("vision.onnx")).unwrap(), BODY);
        assert!(!dir.join("vision.onnx.part").exists());
        assert_eq!(seen.last(), Some(&(BODY.len() as u64, BODY.len() as u64)));
    }

    #[test]
    fn sha256が違うと失敗しpartも本体も残らない() {
        let tmp = tempfile::tempdir().unwrap();
        let url = serve(tmp.path(), b"tampered");
        let dir = tmp.path().join("models");
        let file = model("vision.onnx", &url, BODY);

        let r = prepare(&dir, &[&file], |_, _| {});

        assert!(r.is_err());
        assert!(!dir.join("vision.onnx").exists());
        assert!(!dir.join("vision.onnx.part").exists());
    }

    #[test]
    fn urlが開けないと失敗し前からあったファイルを壊さない() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vision.onnx"), BODY).unwrap();
        let missing = format!("file://{}", tmp.path().join("none.onnx").display());
        let file = model("vision.onnx", &missing, BODY);

        let r = fetch(&missing, &dir, &file, |_| {});

        assert!(r.is_err());
        assert_eq!(fs::read(dir.join("vision.onnx")).unwrap(), BODY);
        assert!(!dir.join("vision.onnx.part").exists());
    }

    #[test]
    fn 中身の違うファイルがあればダウンロードし直す() {
        let tmp = tempfile::tempdir().unwrap();
        let url = serve(tmp.path(), BODY);
        let dir = tmp.path().join("models");
        fs::create_dir_all(&dir).unwrap();
        // 前の版のモデルや、手で置いた別のファイル
        fs::write(dir.join("vision.onnx"), b"old").unwrap();
        let file = model("vision.onnx", &url, BODY);

        prepare(&dir, &[&file], |_, _| {}).unwrap();

        assert_eq!(fs::read(dir.join("vision.onnx")).unwrap(), BODY);
    }

    #[test]
    fn 止まった通信を待ち切れにするオプションを渡す() {
        let c = curl("https://example.test/m.onnx", Path::new("/tmp/m.onnx.part"));
        let args: Vec<_> = c.get_args().map(|a| a.to_string_lossy()).collect();
        let pair = |k: &str, v: &str| args.windows(2).any(|w| w[0] == k && w[1] == v);

        assert!(pair("--connect-timeout", "30"));
        assert!(pair("--speed-limit", "1024"));
        assert!(pair("--speed-time", "60"));
        // 遅い回線でも進んでいる間は止めない
        assert!(!args.iter().any(|a| a == "--max-time"));
    }

    #[test]
    fn 全部そろっていればcurlを起動しない() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vision.onnx"), BODY).unwrap();
        fs::write(dir.join("det.onnx"), b"det").unwrap();
        // curl を起動すれば開けずに失敗する URL。unzip を起動しても、zip がないので失敗する
        let missing = format!("file://{}", tmp.path().join("none.onnx").display());
        let file = model("vision.onnx", &missing, BODY);
        let det = zipped("det.onnx", &missing, b"det", b"zip");
        let mut called = false;

        prepare(&dir, &[&file, &det], |_, _| called = true).unwrap();

        assert!(!called);
        assert_eq!(fs::read(dir.join("vision.onnx")).unwrap(), BODY);
        only(&dir, &["det.onnx", "vision.onnx"]);
    }
}
