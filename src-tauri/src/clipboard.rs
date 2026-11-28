//! 画像をクリップボードに写す（FR-612）。ブラウザが貼り付けで確実に読めるよう、どの形式も PNG にして置く

use std::io::Cursor;
use std::path::Path;

use image::{ImageFormat, ImageReader};
use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
use objc2_foundation::NSData;

/// path の画像を PNG にする。元のファイルは読むだけで変えない
fn png(path: &Path) -> Result<Vec<u8>, String> {
    let image = ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| format!("画像を読めません（{e}）"))?
        .decode()
        .map_err(|e| format!("画像を読めません（{e}）"))?;
    let mut out = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|e| format!("画像を写せません（{e}）"))?;
    Ok(out)
}

/// path の画像をクリップボードに写す。前の中身は消える
pub fn copy_image(path: &Path) -> Result<(), String> {
    let data = NSData::from_vec(png(path)?);
    let board = NSPasteboard::generalPasteboard();
    board.clearContents();
    // SAFETY: AppKit が定める型の名前の定数を読むだけ
    let png_type = unsafe { NSPasteboardTypePNG };
    if board.setData_forType(Some(&data), png_type) {
        Ok(())
    } else {
        Err("画像をクリップボードに写せません".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 本物のクリップボードを書き換えないよう、PNG にするところだけを確かめる
    #[test]
    fn jpeg_を_png_にして写す() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        image::RgbImage::from_pixel(4, 3, image::Rgb([200, 10, 10]))
            .save(&path)
            .unwrap();
        let out = png(&path).unwrap();
        assert!(out.starts_with(b"\x89PNG\r\n\x1a\n"));
        let back = image::load_from_memory(&out).unwrap();
        assert_eq!((back.width(), back.height()), (4, 3));
    }

    #[test]
    fn 読めないファイルならエラーを返す() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        std::fs::write(&path, b"not an image").unwrap();
        assert!(png(&path).unwrap_err().contains("画像を読めません"));
        assert!(png(&dir.path().join("none.jpg")).is_err());
    }
}
