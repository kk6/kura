use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::manifest::{Manifest, ModelFile};

/// ダウンロードするモデルのファイル。学習済みモデルを使わない観点の分はない
pub fn files(manifest: &Manifest) -> Vec<&ModelFile> {
    manifest
        .aspects
        .iter()
        .filter_map(|a| a.file.as_ref())
        .collect()
}

/// ON にする前の確認で見せる大きさ（バイト）
pub fn size(manifest: &Manifest) -> u64 {
    files(manifest).iter().map(|f| f.size).sum()
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
    let total = files.iter().map(|f| f.size).sum();
    let mut done = 0;
    for file in files {
        if !matches(&dir.join(&file.name), &file.sha256) {
            fs::create_dir_all(dir).map_err(|e| format!("モデルの置き場所を作れません（{e}）"))?;
            fetch(&file.url, dir, file, |bytes| progress(done + bytes, total))?;
        }
        done += file.size;
    }
    Ok(())
}

/// url を dir/<名前>.part に書き、SHA-256 が合えば dir/<名前> に置き換える。失敗したら .part を消す。
/// 置き換えるまで前のファイルに触らないので、途中で切れても前のファイルは残る
pub fn fetch(
    url: &str,
    dir: &Path,
    file: &ModelFile,
    progress: impl FnMut(u64),
) -> Result<(), String> {
    let part = dir.join(format!("{}.part", file.name));
    let r = download(url, &part, progress).and_then(|()| {
        if matches(&part, &file.sha256) {
            fs::rename(&part, dir.join(&file.name))
                .map_err(|e| format!("モデルを置けません（{e}）"))
        } else {
            log::error!("ダウンロードしたモデルの SHA-256 が違います：{url}");
            Err("ダウンロードしたモデルの中身が正しくありません".into())
        }
    });
    if r.is_err() && part.exists() {
        if let Err(e) = fs::remove_file(&part) {
            log::error!("書きかけのモデルを消せません：{}：{e}", part.display());
        }
    }
    r
}

// HTTP のクレートを足さないため、macOS に入っている curl を使う
const CURL: &str = "/usr/bin/curl";

/// curl で url を part に書く。動いている間、part の大きさを progress に渡す
fn download(url: &str, part: &Path, mut progress: impl FnMut(u64)) -> Result<(), String> {
    // 通信したことを後から確かめられるよう、通信の前に必ず残す（NFR-08）
    log::info!("モデルをダウンロードします：{url}");
    let mut child = Command::new(CURL)
        .args(["-f", "-L", "-sS", "--output"])
        .arg(part)
        .arg(url)
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
        }
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
    fn 全部そろっていればcurlを起動しない() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vision.onnx"), BODY).unwrap();
        // curl を起動すれば開けずに失敗する URL
        let missing = format!("file://{}", tmp.path().join("none.onnx").display());
        let file = model("vision.onnx", &missing, BODY);
        let mut called = false;

        prepare(&dir, &[&file], |_, _| called = true).unwrap();

        assert!(!called);
        assert_eq!(fs::read(dir.join("vision.onnx")).unwrap(), BODY);
    }
}
