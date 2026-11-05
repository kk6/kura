use std::cell::Cell;
use std::fs;
use std::io::{BufWriter, Cursor};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgb, RgbImage};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::category;
use crate::fileops::{self, OnConflict, Request};
use crate::library::{self, err, Library};

const THUMB_WIDTH: u32 = 320;

/// 時刻は UNIX 時間のミリ秒で保存する
pub(crate) fn millis(t: SystemTime) -> Result<i64, String> {
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
    let dir = library::thumbs_dir(root);
    fs::create_dir_all(&dir).map_err(err)?;
    let tmp = dir.join(format!("{hash}.jpg.tmp"));
    let file = fs::File::create(&tmp).map_err(err)?;
    img.write_with_encoder(JpegEncoder::new_with_quality(BufWriter::new(file), 85))
        .map_err(|e| format!("サムネイルを書けません（{e}）"))?;
    // 書きかけのサムネイルを見せないよう、書き終えてから正式な名前にする
    fs::rename(&tmp, library::thumb_path(root, hash)).map_err(err)
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Added(i64),
    /// 同じ中身の画像（ゴミ箱を含む）の id
    Duplicate(i64),
    /// 同じ中身の画像が未分類にあったので、取り込み先のカテゴリへ移した。その画像の id
    Moved(i64),
    Unsupported,
}

/// ライブラリの外の画像1枚を、category（None は未分類）のフォルダへコピーして登録する。
/// 同じ中身の画像が未分類にあり category が指定されていれば、コピーせずにその画像を category へ移す（FR-204 の例外）
/// 対応している形式なら、その形式。拡張子ではなく中身で判定する。拡張子と中身が食い違うファイルもブラウザやビューアーでは開けるため
pub(crate) fn supported(bytes: &[u8]) -> Option<ImageFormat> {
    match image::guess_format(bytes) {
        Ok(f @ (ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif)) => {
            Some(f)
        }
        _ => None,
    }
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 画像を読んで分かること。サムネイルは render が書く
pub(crate) struct Rendered {
    pub width: u32,
    pub height: u32,
    pub color: String,
}

/// 画像を読み、サムネイルを書いて、幅・高さ・代表色を返す。src はエラーの文言に使う
pub(crate) fn render(
    root: &Path,
    bytes: &[u8],
    format: ImageFormat,
    hash: &str,
    src: &Path,
) -> Result<Rendered, String> {
    let unreadable = |e: image::ImageError| format!("画像を読めません（{}、{e}）", src.display());
    let mut decoder = ImageReader::with_format(Cursor::new(bytes), format)
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
    write_thumb(root, hash, &thumb)?;
    Ok(Rendered {
        width,
        height,
        color,
    })
}

/// 画像の行を足す。登録日時は今の時刻。返り値は新しい行の id
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert(
    conn: &Connection,
    file_name: &str,
    hash: &str,
    r: &Rendered,
    file_size: i64,
    file_mtime: i64,
    category: Option<i64>,
    imported_at: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                            category_id, imported_at, registered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            file_name,
            hash,
            r.width,
            r.height,
            file_size,
            file_mtime,
            r.color,
            category,
            imported_at,
            millis(SystemTime::now())?
        ],
    )
    .map_err(err)?;
    Ok(conn.last_insert_rowid())
}

/// ライブラリの外の画像1枚を、category（None は未分類）のフォルダへコピーして登録する。
/// 同じ中身の画像が未分類にあり category が指定されていれば、コピーせずにその画像を category へ移す（FR-204 の例外）
pub fn import(lib: &mut Library, src: &Path, category: Option<i64>) -> Result<Outcome, String> {
    let bytes = fs::read(src).map_err(|e| format!("{} を読めません（{e}）", src.display()))?;
    let Some(format) = supported(&bytes) else {
        return Ok(Outcome::Unsupported);
    };
    let hash = sha256(&bytes);
    // deleted_at を見ないので、ゴミ箱の画像とも重複を判定する
    if let Some((id, current, trashed)) = lib
        .conn
        .query_row(
            "SELECT id, category_id, deleted_at IS NOT NULL FROM images WHERE hash = ?1",
            [&hash],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?
    {
        // 未分類にある画像だけを移す。別のカテゴリとゴミ箱の画像は、利用者が置いた場所を変えないようスキップする
        if category.is_none() || current.is_some() || trashed {
            return Ok(Outcome::Duplicate(id));
        }
        let r = category::assign(lib, &[id], category)?;
        return match r.failed.into_iter().next() {
            Some(f) => Err(f.message),
            None => Ok(Outcome::Moved(id)),
        };
    }

    let rendered = render(&lib.root, &bytes, format, &hash, src)?;
    let meta = fs::metadata(src).map_err(err)?;
    let imported_at = millis(meta.modified().map_err(err)?)?;
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
            id.set(insert(
                tx,
                op.dst.file_name().and_then(|n| n.to_str()).unwrap_or(name),
                &hash,
                &rendered,
                meta.len() as i64,
                file_mtime,
                category,
                imported_at,
            )?);
            Ok(())
        },
    )?;
    Ok(Outcome::Added(id.get()))
}

/// 取り込まなかった理由
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reason {
    /// 同じ中身の画像（ゴミ箱を含む）がある。existing はその id
    Duplicate {
        existing: i64,
    },
    Unsupported,
    /// 壊れた画像、読めないフォルダ、カテゴリにできない名前のフォルダなど
    Error {
        message: String,
    },
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Skipped {
    pub path: PathBuf,
    #[serde(flatten)]
    pub reason: Reason,
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub added: usize,
    /// 未分類から取り込み先のカテゴリへ移した枚数
    pub moved: usize,
    pub skipped: Vec<Skipped>,
}

const CLOSED: &str = "ライブラリが開かれていません";

/// parent の下にある、name と同名（正規化と大文字・小文字の違いは無視）のカテゴリ。なければ作る
fn category_for(lib: &mut Library, parent: Option<i64>, name: &str) -> Result<i64, String> {
    let siblings = lib
        .conn
        .prepare("SELECT id, name FROM categories WHERE parent_id IS ?1")
        .map_err(err)?
        .query_map([parent], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let key = fileops::key(name.as_ref());
    match siblings
        .into_iter()
        .find(|(_, n)| fileops::key(n.as_ref()) == key)
    {
        Some((id, _)) => Ok(id),
        None => category::create(lib, parent, name),
    }
}

/// paths から取り込む画像と取り込み先を集める。フォルダは parent の下のカテゴリにして、中身も同じように集める。
/// 隠しファイル（. で始まるもの）とシンボリックリンクは飛ばす
fn collect(
    lib: &mut Library,
    paths: &[PathBuf],
    parent: Option<i64>,
    files: &mut Vec<(PathBuf, Option<i64>)>,
    skipped: &mut Vec<Skipped>,
) {
    for path in paths {
        let Some(name) = path.file_name() else {
            continue;
        };
        if name.as_encoded_bytes().starts_with(b".") {
            continue;
        }
        let mut fail = |message: String| {
            skipped.push(Skipped {
                path: path.clone(),
                reason: Reason::Error { message },
            })
        };
        // symlink_metadata はリンクをたどらない
        match fs::symlink_metadata(path) {
            Ok(m) if m.is_file() => files.push((path.clone(), parent)),
            Ok(m) if m.is_dir() => {
                // 読めないフォルダのカテゴリを作らないよう、先に中身を読む
                let children = fs::read_dir(path)
                    .and_then(|entries| entries.map(|e| e.map(|e| e.path())).collect())
                    .map_err(|e| format!("フォルダを読めません（{e}）"));
                match children.and_then(|mut c: Vec<PathBuf>| {
                    c.sort();
                    Ok((category_for(lib, parent, &name.to_string_lossy())?, c))
                }) {
                    Ok((id, children)) => collect(lib, &children, Some(id), files, skipped),
                    Err(message) => fail(message),
                }
            }
            Ok(_) => {}
            Err(e) => fail(e.to_string()),
        }
    }
}

/// ファイルとフォルダをまとめて取り込む（FR-201）。parent（None はルート直下と未分類）の下に取り込む。
/// progress には (取り込み終えた数, 全体の数) を渡す。1枚ごとにロックを外すので、取り込み中も他のコマンドは DB を使える
pub fn import_paths(
    current: &Mutex<Option<Library>>,
    paths: &[PathBuf],
    parent: Option<i64>,
    mut progress: impl FnMut(usize, usize),
) -> Result<Report, String> {
    let mut report = Report::default();
    let mut files = vec![];
    {
        let mut guard = current.lock().unwrap();
        let lib = guard.as_mut().ok_or(CLOSED)?;
        collect(lib, paths, parent, &mut files, &mut report.skipped);
    }
    progress(0, files.len());
    for (i, (src, category)) in files.iter().enumerate() {
        let outcome = {
            let mut guard = current.lock().unwrap();
            import(guard.as_mut().ok_or(CLOSED)?, src, *category)
        };
        let reason = match outcome {
            Ok(Outcome::Added(_)) => {
                report.added += 1;
                None
            }
            Ok(Outcome::Moved(_)) => {
                report.moved += 1;
                None
            }
            Ok(Outcome::Duplicate(existing)) => Some(Reason::Duplicate { existing }),
            Ok(Outcome::Unsupported) => Some(Reason::Unsupported),
            Err(message) => Some(Reason::Error { message }),
        };
        if let Some(reason) = reason {
            report.skipped.push(Skipped {
                path: src.clone(),
                reason,
            });
        }
        progress(i + 1, files.len());
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::Mutex;
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
    fn 同じ中身の画像が未分類にあればカテゴリへの取り込みではその画像をカテゴリへ移す() {
        let mut env = setup();
        let pose = category::create(&mut env.lib, None, "ポーズ").unwrap();
        let a = make(&env, "a.png", 4, 4, [1, 2, 3, 255], ImageFormat::Png);
        let first = added(import(&mut env.lib, &a, None).unwrap());
        env.lib
            .conn
            .execute_batch(&format!(
                "INSERT INTO tags(name) VALUES ('座り'); INSERT INTO image_tags VALUES ({first}, 1);"
            ))
            .unwrap();

        assert_eq!(
            import(&mut env.lib, &a, Some(pose)).unwrap(),
            Outcome::Moved(first)
        );

        assert_eq!(count(&env.lib), 1);
        assert_eq!(row(&env.lib, first).category_id, Some(pose));
        assert_eq!(files(&env.lib.root.join("ポーズ")), ["a.png"]);
        assert_eq!(files(&env.lib.root.join("_未分類")), Vec::<String>::new());
        let tags: i64 = env
            .lib
            .conn
            .query_row("SELECT count(*) FROM image_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tags, 1);
    }

    #[test]
    fn 同じ中身の画像が別のカテゴリかゴミ箱にあれば移さずに重複とする() {
        let mut env = setup();
        let pose = category::create(&mut env.lib, None, "ポーズ").unwrap();
        let hand = category::create(&mut env.lib, None, "手").unwrap();
        let a = make(&env, "a.png", 4, 4, [1, 1, 1, 255], ImageFormat::Png);
        let b = make(&env, "b.png", 4, 4, [2, 2, 2, 255], ImageFormat::Png);
        let in_hand = added(import(&mut env.lib, &a, Some(hand)).unwrap());
        let trashed = added(import(&mut env.lib, &b, None).unwrap());
        crate::trash::trash(&mut env.lib, &[trashed]).unwrap();

        assert_eq!(
            import(&mut env.lib, &a, Some(pose)).unwrap(),
            Outcome::Duplicate(in_hand)
        );
        assert_eq!(
            import(&mut env.lib, &b, Some(pose)).unwrap(),
            Outcome::Duplicate(trashed)
        );
        assert_eq!(row(&env.lib, in_hand).category_id, Some(hand));
        assert_eq!(files(&env.lib.root.join("ポーズ")), Vec::<String>::new());
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

    /// 取り込み元のフォルダの中身を作る。末尾が / ならフォルダ、それ以外は PNG
    fn tree(env: &Env, paths: &[&str]) {
        for (i, p) in paths.iter().enumerate() {
            let path = env.outside.path().join(p);
            if p.ends_with('/') {
                fs::create_dir_all(path).unwrap();
            } else {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                // 中身が重ならないよう、画像ごとに色を変える
                let c = i as u8;
                make(env, p, 4, 4, [c, c, c, 255], ImageFormat::Png);
            }
        }
    }

    fn categories(lib: &Library) -> Vec<String> {
        let ids: Vec<i64> = lib
            .conn
            .prepare("SELECT id FROM categories")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut dirs: Vec<_> = ids
            .into_iter()
            .map(|id| category::dir(lib, Some(id)).unwrap().display().to_string())
            .collect();
        dirs.sort();
        dirs
    }

    fn in_category(lib: &Library, dir: &str) -> Vec<String> {
        let mut names: Vec<String> = lib
            .conn
            .prepare("SELECT file_name, category_id FROM images")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .filter(|(_, c): &(String, Option<i64>)| {
                category::dir(lib, *c).unwrap().display().to_string() == dir
            })
            .map(|(n, _)| n)
            .collect();
        names.sort();
        names
    }

    fn run(lib: Library, paths: &[PathBuf], parent: Option<i64>) -> (Library, Report) {
        let m = Mutex::new(Some(lib));
        let report = import_paths(&m, paths, parent, |_, _| {}).unwrap();
        (m.into_inner().unwrap().unwrap(), report)
    }

    fn reasons(report: &Report) -> Vec<(String, Reason)> {
        report
            .skipped
            .iter()
            .map(|s| {
                let name = s.path.file_name().unwrap().to_string_lossy().into_owned();
                let reason = match &s.reason {
                    // 文言は確かめない
                    Reason::Error { .. } => Reason::Error {
                        message: String::new(),
                    },
                    r => r.clone(),
                };
                (name, reason)
            })
            .collect()
    }

    #[test]
    fn フォルダを取り込むとフォルダ自体とサブフォルダをカテゴリとして再現する() {
        let env = setup();
        tree(
            &env,
            &[
                "資料/直下.png",
                "資料/ポーズ/座り/a.png",
                "資料/ポーズ/b.png",
                "資料/手/c.png",
            ],
        );
        let src = env.outside.path().join("資料");

        let (lib, report) = run(env.lib, &[src], None);

        assert_eq!(report.added, 4);
        assert!(report.skipped.is_empty());
        assert_eq!(
            categories(&lib),
            ["資料", "資料/ポーズ", "資料/ポーズ/座り", "資料/手"]
        );
        assert_eq!(in_category(&lib, "資料"), ["直下.png"]);
        assert_eq!(in_category(&lib, "資料/ポーズ/座り"), ["a.png"]);
        assert!(lib.root.join("資料/ポーズ/座り/a.png").is_file());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 空のサブフォルダもカテゴリとして作る() {
        let env = setup();
        tree(&env, &["資料/背景/空/", "資料/a.png"]);

        let (lib, _) = run(env.lib, &[env.outside.path().join("資料")], None);

        assert_eq!(categories(&lib), ["資料", "資料/背景", "資料/背景/空"]);
        assert!(lib.root.join("資料/背景/空").is_dir());
    }

    #[test]
    fn 同名のカテゴリがあれば新しく作らずに合流する() {
        let mut env = setup();
        let pose = category::create(&mut env.lib, None, "Pose").unwrap();
        category::create(&mut env.lib, Some(pose), "ホ\u{309a}ーズ").unwrap();
        // 大文字・小文字と正規化の違いは同名とみなす
        tree(&env, &["POSE/ポーズ/a.png", "POSE/b.png"]);

        let (lib, report) = run(env.lib, &[env.outside.path().join("POSE")], None);

        assert_eq!(report.added, 2);
        assert_eq!(categories(&lib), ["Pose", "Pose/ポーズ"]);
        assert_eq!(in_category(&lib, "Pose/ポーズ"), ["a.png"]);
        assert_eq!(in_category(&lib, "Pose"), ["b.png"]);
    }

    #[test]
    fn 同じフォルダを2回取り込むとカテゴリは増えず画像は重複としてスキップする() {
        let env = setup();
        tree(&env, &["資料/手/a.png"]);
        let src = env.outside.path().join("資料");
        let (lib, _) = run(env.lib, std::slice::from_ref(&src), None);

        let (lib, report) = run(lib, &[src], None);

        assert_eq!(report.added, 0);
        assert!(matches!(report.skipped[0].reason, Reason::Duplicate { .. }));
        assert_eq!(categories(&lib), ["資料", "資料/手"]);
    }

    #[test]
    fn カテゴリを削除して未分類へ移した画像はフォルダを取り込み直すと元のカテゴリへ戻る() {
        let env = setup();
        tree(&env, &["資料/手/a.png", "資料/b.png"]);
        let src = env.outside.path().join("資料");
        let (mut lib, _) = run(env.lib, std::slice::from_ref(&src), None);
        let top: i64 = lib
            .conn
            .query_row(
                "SELECT id FROM categories WHERE parent_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(category::delete(&mut lib, top).unwrap().error.is_none());

        let (lib, report) = run(lib, &[src], None);

        assert_eq!((report.added, report.moved), (0, 2));
        assert!(report.skipped.is_empty());
        assert_eq!(in_category(&lib, "資料/手"), ["a.png"]);
        assert_eq!(in_category(&lib, "資料"), ["b.png"]);
        assert_eq!(files(&lib.root.join("_未分類")), Vec::<String>::new());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 未分類の画像を移せなければエラーにして残りは続ける() {
        let env = setup();
        tree(&env, &["資料/a.png", "資料/b.png"]);
        let a = env.outside.path().join("資料/a.png");
        let (lib, _) = run(env.lib, &[a], None);
        let uncategorized = lib.root.join("_未分類");
        if !crate::category::tests::lock(&uncategorized) {
            return;
        }

        let (lib, report) = run(lib, &[env.outside.path().join("資料")], None);

        crate::category::tests::unlock(&uncategorized);
        assert_eq!((report.added, report.moved), (1, 0));
        assert_eq!(
            reasons(&report),
            [(
                "a.png".into(),
                Reason::Error {
                    message: String::new()
                }
            )]
        );
        assert_eq!(files(&uncategorized), ["a.png"]);
        assert_eq!(in_category(&lib, "資料"), ["b.png"]);
    }

    #[test]
    fn 隠しファイルと隠しフォルダは無視しシンボリックリンクはたどらない() {
        let env = setup();
        tree(
            &env,
            &[
                "資料/a.png",
                "資料/.隠し.png",
                "資料/.隠しフォルダ/b.png",
                "外/c.png",
                "外/d/e.png",
            ],
        );
        let src = env.outside.path().join("資料");
        let out = env.outside.path().join("外");
        std::os::unix::fs::symlink(out.join("c.png"), src.join("リンク.png")).unwrap();
        std::os::unix::fs::symlink(out.join("d"), src.join("リンク")).unwrap();

        let (lib, report) = run(env.lib, &[src], None);

        assert_eq!(report.added, 1);
        assert!(report.skipped.is_empty());
        assert_eq!(categories(&lib), ["資料"]);
        assert_eq!(in_category(&lib, "資料"), ["a.png"]);
    }

    #[test]
    fn 取り込めなかった画像は理由と一緒に返し残りは取り込む() {
        let env = setup();
        tree(&env, &["資料/a.png", "資料/c.png"]);
        let src = env.outside.path().join("資料");
        // 同じ取り込みの中の2枚目、非対応の形式、壊れた画像
        fs::copy(src.join("a.png"), src.join("b.png")).unwrap();
        fs::write(src.join("d.heic"), b"\0\0\0\x18ftypheic\0\0\0\0mif1heic").unwrap();
        let body = fs::read(src.join("c.png")).unwrap();
        fs::write(src.join("e.png"), &body[..20]).unwrap();

        let (lib, report) = run(env.lib, &[src], None);

        let a: i64 = lib
            .conn
            .query_row("SELECT id FROM images WHERE file_name = 'a.png'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(report.added, 2);
        assert_eq!(
            reasons(&report),
            [
                ("b.png".into(), Reason::Duplicate { existing: a }),
                ("d.heic".into(), Reason::Unsupported),
                (
                    "e.png".into(),
                    Reason::Error {
                        message: String::new()
                    }
                ),
            ]
        );
        assert_eq!(in_category(&lib, "資料"), ["a.png", "c.png"]);
    }

    #[test]
    fn 選んだファイルは未分類か指定したカテゴリに入れる() {
        let mut env = setup();
        let hand = category::create(&mut env.lib, None, "手").unwrap();
        tree(&env, &["a.png", "b.png"]);
        let (a, b) = (
            env.outside.path().join("a.png"),
            env.outside.path().join("b.png"),
        );

        let (lib, _) = run(env.lib, &[a], None);
        let (lib, _) = run(lib, &[b], Some(hand));

        assert_eq!(in_category(&lib, "_未分類"), ["a.png"]);
        assert_eq!(in_category(&lib, "手"), ["b.png"]);
    }

    #[test]
    fn 指定したカテゴリの下にフォルダをカテゴリとして作る() {
        let mut env = setup();
        let pose = category::create(&mut env.lib, None, "ポーズ").unwrap();
        tree(&env, &["座り/a.png"]);

        let (lib, _) = run(env.lib, &[env.outside.path().join("座り")], Some(pose));

        assert_eq!(categories(&lib), ["ポーズ", "ポーズ/座り"]);
        assert_eq!(in_category(&lib, "ポーズ/座り"), ["a.png"]);
    }

    #[test]
    fn カテゴリにできないフォルダはエラーにして中身を取り込まず残りは続ける() {
        let env = setup();
        tree(&env, &["資料/_未分類/a.png", "資料/手/b.png"]);

        let (lib, report) = run(env.lib, &[env.outside.path().join("資料")], None);

        assert_eq!(report.added, 1);
        assert_eq!(
            reasons(&report),
            [(
                "_未分類".into(),
                Reason::Error {
                    message: String::new()
                }
            )]
        );
        assert_eq!(categories(&lib), ["資料", "資料/手"]);
    }

    #[test]
    fn 読めないサブフォルダはエラーにして残りは続ける() {
        let env = setup();
        tree(&env, &["資料/鍵/a.png", "資料/手/b.png"]);
        let locked = env.outside.path().join("資料/鍵");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let (lib, report) = run(env.lib, &[env.outside.path().join("資料")], None);

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(report.added, 1);
        assert_eq!(
            reasons(&report),
            [(
                "鍵".into(),
                Reason::Error {
                    message: String::new()
                }
            )]
        );
        assert_eq!(in_category(&lib, "資料/手"), ["b.png"]);
    }

    #[test]
    fn 途中の1枚のコピーに失敗してもその画像だけをエラーにして予定も残さない() {
        let env = setup();
        tree(&env, &["資料/x/a.png", "資料/y/b.png"]);
        let root = env.lib.root.clone();
        let m = Mutex::new(Some(env.lib));
        let mut seen = vec![];

        let report = import_paths(
            &m,
            &[env.outside.path().join("資料")],
            None,
            |done, total| {
                seen.push((done, total));
                // 1枚目の後に、2枚目の取り込み先のフォルダが Finder で消された
                if done == 1 {
                    fs::remove_dir(root.join("資料/y")).unwrap();
                }
            },
        )
        .unwrap();

        let lib = m.into_inner().unwrap().unwrap();
        assert_eq!(seen, [(0, 2), (1, 2), (2, 2)]);
        assert_eq!(report.added, 1);
        assert_eq!(
            reasons(&report),
            [(
                "b.png".into(),
                Reason::Error {
                    message: String::new()
                }
            )]
        );
        assert_eq!(pending(&lib), 0);
        assert!(env.outside.path().join("資料/y/b.png").is_file());
    }

    #[test]
    fn ライブラリが閉じられていたら取り込まない() {
        let env = setup();
        tree(&env, &["a.png"]);
        let m = Mutex::new(None);

        assert!(import_paths(&m, &[env.outside.path().join("a.png")], None, |_, _| {}).is_err());
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
