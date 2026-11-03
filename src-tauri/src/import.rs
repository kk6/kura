#![cfg_attr(
    not(test),
    expect(dead_code, reason = "取り込みのコマンドはタスク#5 で作る")
)]

use std::cell::Cell;
use std::fmt::Display;
use std::fs;
use std::io::{BufWriter, Cursor};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgb, RgbImage};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::category;
use crate::fileops::{self, OnConflict, Request};
use crate::library::{Library, KURA_DIR};

const THUMB_WIDTH: u32 = 320;

fn err(e: impl Display) -> String {
    e.to_string()
}

/// 時刻は UNIX 時間のミリ秒で保存する
fn millis(t: SystemTime) -> Result<i64, String> {
    Ok(t.duration_since(UNIX_EPOCH).map_err(err)?.as_millis() as i64)
}

/// 透明な部分を白に重ねた RGB にする。JPEG のサムネイルはアルファを持てないため
fn flatten(img: &DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let a = a as u32;
        Rgb([r, g, b].map(|c| ((c as u32 * a + 255 * (255 - a)) / 255) as u8))
    })
}

// shortcut: 代表色はサムネイルの平均の色。色での絞り込み（フェーズ4）で精度が足りなければ、最頻色（減色してから数える）にする
fn average(img: &RgbImage) -> String {
    let mut sum = [0u64; 3];
    for p in img.pixels() {
        for (s, c) in sum.iter_mut().zip(p.0) {
            *s += c as u64;
        }
    }
    let n = (img.width() as u64 * img.height() as u64).max(1);
    let [r, g, b] = sum.map(|s| (s as f64 / n as f64).round() as u8);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// .kura/thumbs/<ハッシュ>.jpg に書く。ハッシュを名前にするので、取り込みが途中で失敗して残っても、次の取り込みで同じファイルを使える
fn write_thumb(root: &Path, hash: &str, img: &RgbImage) -> Result<(), String> {
    let dir = root.join(KURA_DIR).join("thumbs");
    fs::create_dir_all(&dir).map_err(err)?;
    let tmp = dir.join(format!("{hash}.jpg.tmp"));
    let file = fs::File::create(&tmp).map_err(err)?;
    img.write_with_encoder(JpegEncoder::new_with_quality(BufWriter::new(file), 85))
        .map_err(|e| format!("サムネイルを書けません（{e}）"))?;
    // 書きかけのサムネイルを見せないよう、書き終えてから正式な名前にする
    fs::rename(&tmp, dir.join(format!("{hash}.jpg"))).map_err(err)
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Added(i64),
    /// 同じ中身の画像（ゴミ箱を含む）の id
    Duplicate(i64),
    Unsupported,
}

/// ライブラリの外の画像1枚を、category（None は未分類）のフォルダへコピーして登録する
pub fn import(lib: &mut Library, src: &Path, category: Option<i64>) -> Result<Outcome, String> {
    let bytes = fs::read(src).map_err(|e| format!("{} を読めません（{e}）", src.display()))?;
    // 拡張子ではなく中身で判定する。拡張子と中身が食い違うファイルもブラウザやビューアーでは開けるため
    let format = match image::guess_format(&bytes) {
        Ok(f @ (ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif)) => f,
        _ => return Ok(Outcome::Unsupported),
    };
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    // deleted_at を見ないので、ゴミ箱の画像とも重複を判定する
    if let Some(id) = lib
        .conn
        .query_row("SELECT id FROM images WHERE hash = ?1", [&hash], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?
    {
        return Ok(Outcome::Duplicate(id));
    }

    let unreadable = |e: image::ImageError| format!("画像を読めません（{}、{e}）", src.display());
    let mut decoder = ImageReader::with_format(Cursor::new(&bytes), format)
        .into_decoder()
        .map_err(unreadable)?;
    let orientation = decoder.orientation().map_err(unreadable)?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(unreadable)?;
    // 幅と高さは、Exif の向きを反映した表示上の値にする。WebKit も向きを反映して表示するため
    img.apply_orientation(orientation);
    let (width, height) = (img.width(), img.height());
    let thumb = flatten(&match width > THUMB_WIDTH {
        true => img.thumbnail(THUMB_WIDTH, height),
        false => img,
    });
    let color = average(&thumb);
    write_thumb(&lib.root, &hash, &thumb)?;

    let meta = fs::metadata(src).map_err(err)?;
    let imported_at = millis(meta.modified().map_err(err)?)?;
    let registered_at = millis(SystemTime::now())?;
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(format!("ファイル名を扱えません（{}）", src.display()))?;
    let dst_dir = category::dir(lib, category)?;
    let root = lib.root.clone();
    let id = Cell::new(0);
    fileops::transfer(
        lib,
        Request {
            kind: "import",
            target_id: None,
            copy: true,
            src,
            dst_dir: &dst_dir,
            name,
            on_conflict: OnConflict::Number,
        },
        &|tx, op| {
            // file_mtime はコピー先の値。exFAT では更新日時の精度が粗く、元ファイルと一致しないことがあるため
            let file_mtime = millis(
                fs::metadata(root.join(&op.dst))
                    .and_then(|m| m.modified())
                    .map_err(err)?,
            )?;
            tx.execute(
                "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                    category_id, imported_at, registered_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    op.dst.file_name().and_then(|n| n.to_str()),
                    hash,
                    width,
                    height,
                    meta.len() as i64,
                    file_mtime,
                    color,
                    category,
                    imported_at,
                    registered_at
                ],
            )
            .map_err(err)?;
            id.set(tx.last_insert_rowid());
            Ok(())
        },
    )?;
    Ok(Outcome::Added(id.get()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use image::{ImageFormat, Rgba, RgbaImage};
    use tempfile::TempDir;

    use super::*;
    use crate::{category, library};

    struct Env {
        _lib_dir: TempDir,
        outside: TempDir,
        lib: Library,
    }

    // KURA_TEST_DIR に exFAT などのボリュームを指定すると、そのファイルシステムで同じテストを流せる
    fn setup() -> Env {
        let dir = match std::env::var_os("KURA_TEST_DIR") {
            Some(base) => tempfile::tempdir_in(base).unwrap(),
            None => tempfile::tempdir().unwrap(),
        };
        let lib = library::create(dir.path()).unwrap();
        Env {
            _lib_dir: dir,
            outside: tempfile::tempdir().unwrap(),
            lib,
        }
    }

    const MTIME: u64 = 1_600_000_000;

    /// 取り込み元の画像をライブラリの外に作る。更新日時は MTIME 秒
    fn make(env: &Env, name: &str, w: u32, h: u32, color: [u8; 4], format: ImageFormat) -> PathBuf {
        let path = env.outside.path().join(name);
        RgbaImage::from_pixel(w, h, Rgba(color))
            .save_with_format(&path, format)
            .or_else(|_| {
                // JPEG はアルファを持てないので RGB で保存する
                image::DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(color)))
                    .to_rgb8()
                    .save_with_format(&path, format)
            })
            .unwrap();
        set_mtime(&path);
        path
    }

    fn set_mtime(path: &Path) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(MTIME))
            .unwrap();
    }

    struct Row {
        file_name: String,
        hash: String,
        width: i64,
        height: i64,
        file_size: i64,
        file_mtime: i64,
        color: String,
        category_id: Option<i64>,
        imported_at: i64,
        registered_at: i64,
    }

    fn row(lib: &Library, id: i64) -> Row {
        lib.conn
            .query_row(
                "SELECT file_name, hash, width, height, file_size, file_mtime, color,
                        category_id, imported_at, registered_at
                 FROM images WHERE id = ?1",
                [id],
                |r| {
                    Ok(Row {
                        file_name: r.get(0)?,
                        hash: r.get(1)?,
                        width: r.get(2)?,
                        height: r.get(3)?,
                        file_size: r.get(4)?,
                        file_mtime: r.get(5)?,
                        color: r.get(6)?,
                        category_id: r.get(7)?,
                        imported_at: r.get(8)?,
                        registered_at: r.get(9)?,
                    })
                },
            )
            .unwrap()
    }

    fn count(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM images", [], |r| r.get(0))
            .unwrap()
    }

    fn pending(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM pending_ops", [], |r| r.get(0))
            .unwrap()
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with("._"))
            .collect();
        names.sort();
        names
    }

    fn added(outcome: Outcome) -> i64 {
        match outcome {
            Outcome::Added(id) => id,
            o => panic!("取り込まれていません：{o:?}"),
        }
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn 対応形式の画像は未分類にコピーして情報を記録する() {
        let mut env = setup();
        let cases = [
            ("a.jpg", ImageFormat::Jpeg),
            ("b.png", ImageFormat::Png),
            ("c.webp", ImageFormat::WebP),
            ("d.gif", ImageFormat::Gif),
        ];
        for (name, format) in cases {
            let src = make(&env, name, 40, 30, [255, 0, 0, 255], format);
            let before = now_ms();

            let id = added(import(&mut env.lib, &src, None).unwrap());

            let r = row(&env.lib, id);
            let copied = env.lib.root.join("_未分類").join(name);
            assert_eq!(
                fs::read(&copied).unwrap(),
                fs::read(&src).unwrap(),
                "{name}"
            );
            assert_eq!(r.file_name, name);
            assert_eq!(r.category_id, None);
            assert_eq!((r.width, r.height), (40, 30), "{name}");
            assert_eq!(r.file_size, fs::metadata(&src).unwrap().len() as i64);
            // JPEG は非可逆なので赤に近ければよい
            let rgb = u32::from_str_radix(&r.color[1..], 16)
                .unwrap()
                .to_be_bytes();
            assert!(
                rgb[1] > 240 && rgb[2] < 16 && rgb[3] < 16,
                "{name} {}",
                r.color
            );
            assert_eq!(r.hash.len(), 64);
            assert_eq!(r.imported_at, MTIME as i64 * 1000);
            assert_eq!(r.file_mtime, MTIME as i64 * 1000);
            assert!(before <= r.registered_at && r.registered_at <= now_ms());
            let thumb = env.lib.root.join(format!(".kura/thumbs/{}.jpg", r.hash));
            assert!(image::open(&thumb).is_ok(), "{name}");
        }
        assert_eq!(pending(&env.lib), 0);
    }

    #[test]
    fn 代表色は画像の平均の色() {
        let mut env = setup();
        let src = make(&env, "a.png", 10, 10, [0, 128, 255, 255], ImageFormat::Png);

        let id = added(import(&mut env.lib, &src, None).unwrap());

        assert_eq!(row(&env.lib, id).color, "#0080ff");
    }

    #[test]
    fn 透明な部分は白として代表色とサムネイルを作る() {
        let mut env = setup();
        let src = make(&env, "a.png", 10, 10, [0, 0, 0, 0], ImageFormat::Png);

        let id = added(import(&mut env.lib, &src, None).unwrap());

        assert_eq!(row(&env.lib, id).color, "#ffffff");
    }

    #[test]
    fn カテゴリを指定するとそのフォルダへ取り込む() {
        let mut env = setup();
        let pose = category::create(&mut env.lib, None, "ポーズ").unwrap();
        let sit = category::create(&mut env.lib, Some(pose), "座り").unwrap();
        let src = make(&env, "a.png", 4, 4, [0, 0, 0, 255], ImageFormat::Png);

        let id = added(import(&mut env.lib, &src, Some(sit)).unwrap());

        assert_eq!(files(&env.lib.root.join("ポーズ/座り")), ["a.png"]);
        assert_eq!(row(&env.lib, id).category_id, Some(sit));
    }

    #[test]
    fn 元のファイルは変えずに残す() {
        let mut env = setup();
        let src = make(&env, "a.png", 4, 4, [0, 0, 0, 255], ImageFormat::Png);
        let body = fs::read(&src).unwrap();

        import(&mut env.lib, &src, None).unwrap();

        assert_eq!(fs::read(&src).unwrap(), body);
        assert_eq!(
            fs::metadata(&src).unwrap().modified().unwrap(),
            UNIX_EPOCH + Duration::from_secs(MTIME)
        );
    }

    #[test]
    fn 対応していない形式は取り込まない() {
        let mut env = setup();
        let text = env.outside.path().join("メモ.jpg");
        fs::write(&text, "画像ではない").unwrap();
        // HEIC の先頭（ISO BMFF の ftyp ボックス）
        let heic = env.outside.path().join("a.heic");
        fs::write(&heic, b"\0\0\0\x18ftypheic\0\0\0\0mif1heic").unwrap();
        // TIFF（リトルエンディアン）の先頭
        let tiff = env.outside.path().join("a.tif");
        fs::write(&tiff, b"II*\0\x08\0\0\0").unwrap();

        for src in [text, heic, tiff] {
            assert_eq!(
                import(&mut env.lib, &src, None).unwrap(),
                Outcome::Unsupported
            );
        }

        assert_eq!(count(&env.lib), 0);
        assert_eq!(files(&env.lib.root.join("_未分類")), Vec::<String>::new());
    }

    #[test]
    fn 拡張子ではなく中身で形式を判定する() {
        let mut env = setup();
        let src = make(
            &env,
            "png なのに.jpg",
            4,
            4,
            [0, 0, 0, 255],
            ImageFormat::Png,
        );

        added(import(&mut env.lib, &src, None).unwrap());

        assert_eq!(files(&env.lib.root.join("_未分類")), ["png なのに.jpg"]);
    }

    #[test]
    fn 形式は対応していても壊れていて読めない画像はエラーにして何も残さない() {
        let mut env = setup();
        let src = make(&env, "a.png", 4, 4, [0, 0, 0, 255], ImageFormat::Png);
        let body = fs::read(&src).unwrap();
        fs::write(&src, &body[..20]).unwrap();

        assert!(import(&mut env.lib, &src, None).is_err());

        assert_eq!(count(&env.lib), 0);
        assert_eq!(files(&env.lib.root.join("_未分類")), Vec::<String>::new());
    }

    #[test]
    fn 同じ中身の画像は名前が違っても取り込まずに既存の画像を返す() {
        let mut env = setup();
        let a = make(&env, "a.png", 4, 4, [1, 2, 3, 255], ImageFormat::Png);
        let b = env.outside.path().join("別名.png");
        fs::copy(&a, &b).unwrap();
        let first = added(import(&mut env.lib, &a, None).unwrap());

        assert_eq!(
            import(&mut env.lib, &b, None).unwrap(),
            Outcome::Duplicate(first)
        );
        // 同じ取り込みの中で2回目に出てきた場合も同じ
        assert_eq!(
            import(&mut env.lib, &a, None).unwrap(),
            Outcome::Duplicate(first)
        );

        assert_eq!(count(&env.lib), 1);
        assert_eq!(files(&env.lib.root.join("_未分類")), ["a.png"]);
    }

    #[test]
    fn ゴミ箱にある画像と同じ中身なら取り込まない() {
        let mut env = setup();
        let a = make(&env, "a.png", 4, 4, [1, 2, 3, 255], ImageFormat::Png);
        let first = added(import(&mut env.lib, &a, None).unwrap());
        env.lib
            .conn
            .execute("UPDATE images SET deleted_at = 1 WHERE id = ?1", [first])
            .unwrap();

        assert_eq!(
            import(&mut env.lib, &a, None).unwrap(),
            Outcome::Duplicate(first)
        );
        assert_eq!(count(&env.lib), 1);
    }

    #[test]
    fn 同名の別の画像があれば連番を付けて取り込む() {
        let mut env = setup();
        let a = make(&env, "a.png", 4, 4, [1, 1, 1, 255], ImageFormat::Png);
        added(import(&mut env.lib, &a, None).unwrap());
        // 大文字・小文字だけが違う名前も同名とみなす
        let b = make(&env, "A.png", 4, 4, [2, 2, 2, 255], ImageFormat::Png);

        let id = added(import(&mut env.lib, &b, None).unwrap());

        assert_eq!(row(&env.lib, id).file_name, "A (2).png");
        assert_eq!(files(&env.lib.root.join("_未分類")), ["A (2).png", "a.png"]);
    }

    /// 幅 w・高さ h の JPEG を作り、orientation があれば Exif（APP1）に向きを書き込む
    fn make_jpeg(env: &Env, name: &str, w: u32, h: u32, orientation: Option<u8>) -> PathBuf {
        let path = make(env, name, w, h, [0, 0, 0, 255], ImageFormat::Jpeg);
        if let Some(o) = orientation {
            // image クレートは Exif を書けないので、APP1 を組み立てて SOI（先頭2バイト）の直後に入れる
            let mut app1 = vec![0xFF, 0xE1, 0, 34];
            app1.extend_from_slice(b"Exif\0\0");
            // TIFF ヘッダー（ビッグエンディアン、IFD は8バイト目から）
            app1.extend_from_slice(b"MM\0\x2A\0\0\0\x08");
            // IFD：項目1つ（0x0112 Orientation、SHORT、1個、値 o）、次の IFD はなし
            app1.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0]);
            app1.extend_from_slice(&[0, 0, 0, 0]);
            assert_eq!(app1.len(), 2 + 34);
            let mut body = fs::read(&path).unwrap();
            body.splice(2..2, app1);
            fs::write(&path, body).unwrap();
            set_mtime(&path);
        }
        path
    }

    #[test]
    fn exifの向きが6の画像は幅と高さを入れ替えて記録しサムネイルも回す() {
        let mut env = setup();
        let src = make_jpeg(&env, "a.jpg", 400, 200, Some(6));
        let body = fs::read(&src).unwrap();

        let id = added(import(&mut env.lib, &src, None).unwrap());

        let r = row(&env.lib, id);
        assert_eq!((r.width, r.height), (200, 400));
        let thumb = image::open(env.lib.root.join(format!(".kura/thumbs/{}.jpg", r.hash))).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (200, 400));
        // 元ファイルの中身は変えない（回すのは表示上だけ）
        assert_eq!(fs::read(env.lib.root.join("_未分類/a.jpg")).unwrap(), body);
    }

    #[test]
    fn exifの向きがないか1の画像は幅と高さをそのまま記録する() {
        let mut env = setup();
        let none = make_jpeg(&env, "none.jpg", 400, 200, None);
        let one = make_jpeg(&env, "one.jpg", 400, 200, Some(1));

        for src in [none, one] {
            let id = added(import(&mut env.lib, &src, None).unwrap());
            let r = row(&env.lib, id);
            assert_eq!((r.width, r.height), (400, 200), "{}", src.display());
        }
    }

    #[test]
    fn サムネイルは幅320pxに縮め小さい画像は拡大しない() {
        let mut env = setup();
        let big = make(&env, "big.png", 640, 960, [9, 9, 9, 255], ImageFormat::Png);
        let small = make(&env, "small.png", 100, 50, [8, 8, 8, 255], ImageFormat::Png);

        for (src, size) in [(big, (320, 480)), (small, (100, 50))] {
            let id = added(import(&mut env.lib, &src, None).unwrap());
            let hash = row(&env.lib, id).hash;
            let thumb = image::open(env.lib.root.join(format!(".kura/thumbs/{hash}.jpg"))).unwrap();
            assert_eq!((thumb.width(), thumb.height()), size);
        }
    }

    #[test]
    fn コピーに失敗したらエラーにして登録も予定も残さない() {
        let mut env = setup();
        let pose = category::create(&mut env.lib, None, "ポーズ").unwrap();
        // Finder でカテゴリのフォルダが消された
        fs::remove_dir(env.lib.root.join("ポーズ")).unwrap();
        let src = make(&env, "a.png", 4, 4, [0, 0, 0, 255], ImageFormat::Png);

        assert!(import(&mut env.lib, &src, Some(pose)).is_err());

        assert_eq!(count(&env.lib), 0);
        assert_eq!(pending(&env.lib), 0);
        assert!(src.is_file());
    }

    #[test]
    fn 登録の直前で止まった取り込みは起動時にファイルを残して予定を消す() {
        let env = setup();
        let src = make(&env, "a.png", 4, 4, [0, 0, 0, 255], ImageFormat::Png);
        // コピーと rename は終わり、DB の登録の前に止まった状態
        fs::copy(&src, env.lib.root.join("_未分類/a.png")).unwrap();
        env.lib
            .conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst) VALUES ('import', NULL, 1, ?1, '_未分類/a.png')",
                [src.to_str().unwrap()],
            )
            .unwrap();
        let root = env.lib.root.clone();
        drop(env.lib);

        let lib = library::open(&root).unwrap();

        // 登録は差分検出（FR-104）が新しいファイルとして行う
        assert_eq!(pending(&lib), 0);
        assert_eq!(count(&lib), 0);
        assert!(root.join("_未分類/a.png").is_file());
    }
}
