//! スパイク：ファイルの移動とDBの更新の途中で止まっても、画像を失わず不整合を検出・回復できるか。
//!
//! 使い方：
//!   crash-safe-move init <lib>
//!   crash-safe-move move <lib> <image_id> <category>   （KURA_CRASH_AT で途中停止）
//!   crash-safe-move recover <lib>
//!   crash-safe-move check <lib>
use rusqlite::{params, Connection};
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::{env, fs, io};

fn main() {
    let args: Vec<String> = env::args().collect();
    let lib = Path::new(&args[2]);
    let result = match args[1].as_str() {
        "init" => init(lib),
        "move" => {
            let conn = open(lib).unwrap();
            move_image(&conn, lib, args[3].parse().unwrap(), &args[4]).map(|_| ())
        }
        "recover" => {
            let conn = open(lib).unwrap();
            recover(&conn, lib).map(|n| println!("recovered {n}"))
        }
        "check" => {
            let conn = open(lib).unwrap();
            check(&conn, lib).map(|problems| {
                for p in &problems {
                    println!("{p}");
                }
                if !problems.is_empty() {
                    std::process::exit(2);
                }
            })
        }
        other => panic!("unknown command {other}"),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn open(lib: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(lib.join(".kura/kura.db"))?;
    // FULL：電源断でも直前のコミットを失わないため（WALの NORMAL はプロセス停止には耐えるが電源断では最後のコミットを失いうる）
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
    Ok(conn)
}

fn init(lib: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(lib.join(".kura"))?;
    for c in ["座り", "立ち"] {
        fs::create_dir_all(lib.join(c))?;
    }
    fs::write(lib.join("座り/a.jpg"), b"dummy image a")?;
    fs::write(lib.join("立ち/a.jpg"), b"dummy image b")?; // 移動先の同名ファイル（上書きしないことを確かめる）
    let conn = open(lib)?;
    conn.execute_batch(
        "CREATE TABLE images(id INTEGER PRIMARY KEY, category TEXT NOT NULL, filename TEXT NOT NULL);
         CREATE TABLE pending_ops(id INTEGER PRIMARY KEY, image_id INTEGER NOT NULL,
             from_category TEXT NOT NULL, from_filename TEXT NOT NULL,
             to_category TEXT NOT NULL, to_filename TEXT NOT NULL);
         INSERT INTO images(id, category, filename) VALUES (1, '座り', 'a.jpg'), (2, '立ち', 'a.jpg');",
    )?;
    Ok(())
}

fn crash_point(name: &str) {
    if env::var("KURA_CRASH_AT").as_deref() == Ok(name) {
        std::process::abort();
    }
}

/// 上書きせずに名前を変える。移動先があれば EEXIST で失敗する（存在確認と rename の間の競合もない）。
fn rename_no_overwrite(from: &Path, to: &Path) -> io::Result<()> {
    let f = CString::new(from.as_os_str().as_bytes())?;
    let t = CString::new(to.as_os_str().as_bytes())?;
    if unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// 連番を付けた、移動先フォルダで空いている名前を返す（a.jpg → a (2).jpg）。
fn free_name(dir: &Path, filename: &str) -> String {
    if !dir.join(filename).exists() {
        return filename.to_string();
    }
    let (stem, ext) = filename.rsplit_once('.').unwrap_or((filename, ""));
    (2..)
        .map(|n| if ext.is_empty() { format!("{stem} ({n})") } else { format!("{stem} ({n}).{ext}") })
        .find(|name| !dir.join(name).exists())
        .unwrap()
}

/// 手順：1) 予定をDBに記録 → 2) 上書きしない rename → 3) imagesの更新と予定の削除を1トランザクションで。
/// どこで止まっても、ファイルは移動元か移動先のどちらか一方に必ずある。
pub fn move_image(conn: &Connection, lib: &Path, image_id: i64, to_category: &str) -> Result<String, Box<dyn std::error::Error>> {
    let (from_category, filename): (String, String) =
        conn.query_row("SELECT category, filename FROM images WHERE id=?1", [image_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let to_filename = free_name(&lib.join(to_category), &filename);

    conn.execute(
        "INSERT INTO pending_ops(image_id, from_category, from_filename, to_category, to_filename) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![image_id, from_category, filename, to_category, to_filename],
    )?;
    crash_point("after_journal");

    rename_no_overwrite(&lib.join(&from_category).join(&filename), &lib.join(to_category).join(&to_filename))?;
    crash_point("after_rename");

    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE images SET category=?1, filename=?2 WHERE id=?3", params![to_category, to_filename, image_id])?;
    tx.execute("DELETE FROM pending_ops WHERE image_id=?1", [image_id])?;
    crash_point("before_commit");
    tx.commit()?;
    Ok(to_filename)
}

/// 起動時に呼ぶ。残っている予定を、実ファイルの位置に合わせて完了させるか取り消す。
pub fn recover(conn: &Connection, lib: &Path) -> Result<usize, Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare("SELECT id, image_id, from_category, from_filename, to_category, to_filename FROM pending_ops")?;
    let ops: Vec<(i64, i64, String, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<Result<_, _>>()?;
    for (op_id, image_id, fc, ff, tc, tf) in &ops {
        let at_from = lib.join(fc).join(ff).exists();
        let at_to = lib.join(tc).join(tf).exists();
        let tx = conn.unchecked_transaction()?;
        match (at_from, at_to) {
            // rename の前に止まった：移動は起きていないので予定を消すだけ
            (true, false) => {}
            // rename の後に止まった：DBを移動先に合わせる
            (false, true) => {
                tx.execute("UPDATE images SET category=?1, filename=?2 WHERE id=?3", params![tc, tf, image_id])?;
            }
            // 両方ある・両方ない：自動では判断しない。予定を残して利用者に知らせる（checkが報告する）
            _ => continue,
        }
        tx.execute("DELETE FROM pending_ops WHERE id=?1", [op_id])?;
        tx.commit()?;
    }
    Ok(ops.len())
}

/// DBと実ファイルの不整合を列挙する（FR-104の差分検出の最小版）。
pub fn check(conn: &Connection, lib: &Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let mut problems = Vec::new();
    let pending: i64 = conn.query_row("SELECT count(*) FROM pending_ops", [], |r| r.get(0))?;
    if pending > 0 {
        problems.push(format!("pending ops: {pending}"));
    }
    let mut stmt = conn.prepare("SELECT id, category, filename FROM images")?;
    let rows: Vec<(i64, String, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    let known: Vec<PathBuf> = rows.iter().map(|(_, c, f)| lib.join(c).join(f)).collect();
    for ((id, _, _), path) in rows.iter().zip(&known) {
        if !path.exists() {
            problems.push(format!("missing file for image {id}: {}", path.display()));
        }
    }
    for entry in fs::read_dir(lib)? {
        let dir = entry?.path();
        if !dir.is_dir() || dir.file_name().is_some_and(|n| n == ".kura") {
            continue;
        }
        for f in fs::read_dir(&dir)? {
            let path = f?.path();
            if !known.contains(&path) {
                problems.push(format!("untracked file: {}", path.display()));
            }
        }
    }
    Ok(problems)
}
