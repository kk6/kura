use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::import::millis;
use crate::library::err;

/// ブラウザがダウンロードしたファイルに付ける、ダウンロード元の記録（FR-208）
const ATTR: &str = "com.apple.metadata:kMDItemWhereFroms";

/// 画像の元URL。どちらかは必ずある
#[derive(Debug, PartialEq)]
pub struct Source {
    pub image_url: Option<String>,
    pub page_url: Option<String>,
}

/// ファイルから読んだダウンロード元の記録。note は、結果の注意に出す文
#[derive(Debug, Default, PartialEq)]
pub struct Read {
    pub source: Option<Source>,
    pub note: Option<String>,
}

/// 取り込みと差分検出の結果に出す、元URLの注意。画像そのものは登録できている
#[derive(Debug, PartialEq, Serialize)]
pub struct Note {
    pub path: PathBuf,
    pub message: String,
}

/// HTTP か HTTPS の URL なら、正規化した文字列を返す。通信はしない
pub fn valid(url: &str) -> Option<String> {
    let url = tauri::Url::parse(url).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.has_host()).then(|| url.into())
}

/// 詳細パネルから開く URL。有効な掲載ページURLを優先し、なければ画像URL
pub fn link(image_url: Option<&str>, page_url: Option<&str>) -> Option<String> {
    page_url
        .and_then(valid)
        .or_else(|| image_url.and_then(valid))
}

/// path の拡張属性を直接読む。Spotlight（mdls）は値を返さないことがあるので使わない。属性がなければ None
fn xattr(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let path = CString::new(path.as_os_str().as_bytes())?;
    let name = CString::new(ATTR)?;
    // 大きさを聞いてから読む。その間に属性が大きくなると ERANGE で失敗し、読めない記録として注意に出る
    let get = |buf: Option<&mut [u8]>| {
        // 大きさを聞くときは NULL を渡す。長さ0の配列のポインターでは ERANGE になるため
        let (ptr, len) = match buf {
            Some(b) => (b.as_mut_ptr().cast(), b.len()),
            None => (std::ptr::null_mut(), 0),
        };
        // SAFETY: path と name は NUL で終わり、len バイトまでしか書かせない
        match unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), ptr, len, 0, 0) } {
            n if n >= 0 => Ok(Some(n as usize)),
            _ => match io::Error::last_os_error() {
                e if e.raw_os_error() == Some(libc::ENOATTR) => Ok(None),
                e => Err(e),
            },
        }
    };
    let Some(len) = get(None)? else {
        return Ok(None);
    };
    let mut buf = vec![0; len];
    Ok(get(Some(&mut buf))?.map(|n| {
        buf.truncate(n);
        buf
    }))
}

/// 記録の1項目。空文字列は Chrome が参照元なしのときに書くので、欠けている扱いにして注意を出さない
enum Slot {
    Absent,
    Valid(String),
    Invalid,
}

fn slot(items: &[plist::Value], i: usize) -> Slot {
    match items.get(i) {
        None => Slot::Absent,
        Some(plist::Value::String(s)) if s.is_empty() => Slot::Absent,
        Some(plist::Value::String(s)) => valid(s).map_or(Slot::Invalid, Slot::Valid),
        Some(_) => Slot::Invalid,
    }
}

/// 1番目を画像URL、2番目を掲載ページURLとして別々に確かめる。詰めて役割を入れ替えず、3番目からは使わない
fn interpret(attr: io::Result<Option<Vec<u8>>>) -> Read {
    let note = |message: String| Read {
        source: None,
        note: Some(message),
    };
    let bytes = match attr {
        Ok(None) => return Read::default(),
        Ok(Some(bytes)) => bytes,
        Err(e) => return note(format!("ダウンロード元の記録を読めません（{e}）")),
    };
    // binary と XML のどちらの plist も読む
    let Ok(plist::Value::Array(items)) = plist::Value::from_reader(io::Cursor::new(bytes)) else {
        return note("ダウンロード元の記録を解析できません".into());
    };
    match (slot(&items, 0), slot(&items, 1)) {
        (Slot::Valid(image), Slot::Invalid) => Read {
            source: Some(Source {
                image_url: Some(image),
                page_url: None,
            }),
            note: Some(
                "ダウンロード元の記録の掲載ページURLが不正なため、画像URLだけを保存しました".into(),
            ),
        },
        (Slot::Invalid, Slot::Valid(page)) => Read {
            source: Some(Source {
                image_url: None,
                page_url: Some(page),
            }),
            note: Some(
                "ダウンロード元の記録の画像URLが不正なため、掲載ページURLだけを保存しました".into(),
            ),
        },
        (Slot::Invalid, _) | (_, Slot::Invalid) => {
            note("ダウンロード元の記録に、保存できるURLがありません".into())
        }
        (Slot::Absent, Slot::Absent) => Read::default(),
        (image, page) => {
            let some = |s| match s {
                Slot::Valid(url) => Some(url),
                _ => None,
            };
            Read {
                source: Some(Source {
                    image_url: some(image),
                    page_url: some(page),
                }),
                note: None,
            }
        }
    }
}

/// path のファイルのダウンロード元の記録を読む。失敗しても取り込みを止めないよう、エラーは note で返す
pub fn read(path: &Path) -> Read {
    interpret(xattr(path))
}

/// 新しく登録した画像の元URLを保存する
pub fn save(conn: &Connection, image_id: i64, source: &Source) -> Result<(), String> {
    conn.execute(
        "INSERT INTO image_sources(image_id, image_url, page_url, fetched_at) VALUES (?1, ?2, ?3, ?4)",
        params![image_id, source.image_url, source.page_url, millis(SystemTime::now())?],
    )
    .map_err(err)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::fs;

    use super::*;

    const IMAGE: &str = "https://img.example.com/a.jpg";
    const PAGE: &str = "https://example.com/gallery";

    pub(crate) fn binary(items: &[&str]) -> Vec<u8> {
        let value = plist::Value::Array(
            items
                .iter()
                .map(|s| plist::Value::String((*s).into()))
                .collect(),
        );
        let mut bytes = vec![];
        value.to_writer_binary(&mut bytes).unwrap();
        bytes
    }

    /// path に拡張属性 kMDItemWhereFroms を付ける。ブラウザがダウンロードしたファイルの代わり
    pub(crate) fn set(path: &Path, bytes: &[u8]) {
        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let name = CString::new(ATTR).unwrap();
        // SAFETY: path と name は NUL で終わり、bytes.len() バイトだけ読ませる
        let r = unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
                0,
            )
        };
        assert_eq!(r, 0, "{}", io::Error::last_os_error());
    }

    fn read_bytes(bytes: &[u8]) -> Read {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        fs::write(&path, "画像").unwrap();
        set(&path, bytes);
        read(&path)
    }

    fn both() -> Read {
        Read {
            source: Some(Source {
                image_url: Some(IMAGE.into()),
                page_url: Some(PAGE.into()),
            }),
            note: None,
        }
    }

    #[test]
    fn binaryのplistの1番目を画像urlに2番目を掲載ページurlにする() {
        assert_eq!(read_bytes(&binary(&[IMAGE, PAGE])), both());
    }

    #[test]
    fn xmlのplistも読む() {
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><string>{IMAGE}</string><string>{PAGE}</string></array></plist>"#
        );
        assert_eq!(read_bytes(xml.as_bytes()), both());
    }

    #[test]
    fn 記録がないファイルは元urlも注意もない() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        fs::write(&path, "画像").unwrap();
        assert_eq!(read(&path), Read::default());
    }

    #[test]
    fn plistでない記録と配列でない記録は注意だけを返す() {
        for bytes in ["plist ではない".as_bytes().to_vec(), {
            let mut b = vec![];
            plist::Value::String(IMAGE.into())
                .to_writer_binary(&mut b)
                .unwrap();
            b
        }] {
            let r = read_bytes(&bytes);
            assert_eq!(r.source, None);
            assert_eq!(
                r.note.as_deref(),
                Some("ダウンロード元の記録を解析できません")
            );
        }
    }

    #[test]
    fn 属性を読めないときは注意だけを返す() {
        let r = interpret(Err(io::Error::from_raw_os_error(libc::EACCES)));
        assert_eq!(r.source, None);
        assert!(r
            .note
            .unwrap()
            .starts_with("ダウンロード元の記録を読めません（"));
    }

    #[test]
    fn 一方だけ有効ならその役割のまま保存して注意を出す() {
        let r = read_bytes(&binary(&["壊れた記録", PAGE]));
        assert_eq!(
            r.source,
            Some(Source {
                image_url: None,
                page_url: Some(PAGE.into())
            })
        );
        assert!(r.note.unwrap().contains("画像URLが不正"));

        let r = read_bytes(&binary(&[IMAGE, "ftp://example.com/page"]));
        assert_eq!(
            r.source,
            Some(Source {
                image_url: Some(IMAGE.into()),
                page_url: None
            })
        );
        assert!(r.note.unwrap().contains("掲載ページURLが不正"));
    }

    #[test]
    fn httpとhttps以外と不正なurlだけの記録は保存せず注意を出す() {
        for items in [
            &["file:///Users/me/a.jpg", "javascript:alert(1)"][..],
            &["ftp://example.com/a.jpg"],
            &["http://", "https://"],
        ] {
            let r = read_bytes(&binary(items));
            assert_eq!(r.source, None, "{items:?}");
            assert_eq!(
                r.note.as_deref(),
                Some("ダウンロード元の記録に、保存できるURLがありません")
            );
        }
    }

    #[test]
    fn 文字列でない項目は不正として扱う() {
        let mut bytes = vec![];
        plist::Value::Array(vec![
            plist::Value::Integer(1.into()),
            plist::Value::String(PAGE.into()),
        ])
        .to_writer_binary(&mut bytes)
        .unwrap();
        let r = read_bytes(&bytes);
        assert_eq!(r.source.unwrap().page_url.as_deref(), Some(PAGE));
        assert!(r.note.is_some());
    }

    #[test]
    fn 項目が1つか2番目が空文字列なら画像urlだけを保存して注意を出さない() {
        for items in [&[IMAGE][..], &[IMAGE, ""]] {
            assert_eq!(
                read_bytes(&binary(items)),
                Read {
                    source: Some(Source {
                        image_url: Some(IMAGE.into()),
                        page_url: None
                    }),
                    note: None
                }
            );
        }
    }

    #[test]
    fn 空の配列は記録なしとして扱う() {
        assert_eq!(read_bytes(&binary(&[])), Read::default());
    }

    #[test]
    fn 三番目からの項目は使わず詰めもしない() {
        assert_eq!(
            read_bytes(&binary(&[IMAGE, PAGE, "https://example.com/third"])),
            both()
        );
        // 2番目が欠けていても、3番目を掲載ページURLにしない
        let r = read_bytes(&binary(&[IMAGE, "", "https://example.com/third"]));
        assert_eq!(r.source.unwrap().page_url, None);
    }

    #[test]
    fn 開くurlは有効な掲載ページurlを優先し不正なら画像urlにする() {
        assert_eq!(link(Some(IMAGE), Some(PAGE)).as_deref(), Some(PAGE));
        assert_eq!(link(Some(IMAGE), None).as_deref(), Some(IMAGE));
        assert_eq!(
            link(Some(IMAGE), Some("file:///etc/hosts")).as_deref(),
            Some(IMAGE)
        );
        assert_eq!(link(None, Some(PAGE)).as_deref(), Some(PAGE));
        assert_eq!(link(Some("javascript:alert(1)"), Some("壊れた値")), None);
        assert_eq!(link(None, None), None);
    }
}
