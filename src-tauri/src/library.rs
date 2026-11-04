use std::ffi::CString;
use std::fmt::Display;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, Transaction};

use crate::fileops::{self, PendingOp};

pub const KURA_DIR: &str = ".kura";
pub const UNCATEGORIZED_DIR: &str = "_未分類";

// 1つが1つの版。後のタスクでテーブルを足すときは末尾に足し、既存の要素は書き換えない
const MIGRATIONS: &[&str] = &[
    // src と dst はライブラリのルートからの相対パス。外付けドライブのマウント先が変わっても後始末できるようにするため
    "CREATE TABLE pending_ops(
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        target_id INTEGER,
        copy INTEGER NOT NULL,
        src TEXT NOT NULL,
        dst TEXT NOT NULL
    )",
    // 同名の判定は DB ではなく実際のフォルダの中身で行うので、name に一意制約は付けない
    "CREATE TABLE categories(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES categories(id),
        sort_order INTEGER NOT NULL DEFAULT 0
    )",
    // 時刻は UNIX 時間のミリ秒。hash の一意制約は、重複を取り込まない決まり（FR-204）の最後の守り
    "CREATE TABLE images(
        id INTEGER PRIMARY KEY,
        file_name TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        file_mtime INTEGER NOT NULL,
        color TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id),
        rating INTEGER NOT NULL DEFAULT 0,
        memo TEXT NOT NULL DEFAULT '',
        imported_at INTEGER NOT NULL,
        registered_at INTEGER NOT NULL,
        deleted_at INTEGER,
        missing_at INTEGER
    )",
    // 一覧のサイドバー（FR-503）で読むために先に作る。名前の重複の判定（NFC と大文字・小文字）は
    // categories と同じくアプリ側で行う。グループ（FR-409、Could）は要るときに列を足す
    "CREATE TABLE tags(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
    );
    CREATE TABLE image_tags(
        image_id INTEGER NOT NULL REFERENCES images(id),
        tag_id INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY(image_id, tag_id)
    )",
    // 詳細パネル（FR-507）で元URLを読むために先に作る。書き込むのは URL 取り込み（フェーズ2）
    "CREATE TABLE image_sources(
        image_id INTEGER PRIMARY KEY REFERENCES images(id),
        image_url TEXT NOT NULL,
        page_url TEXT,
        fetched_at INTEGER NOT NULL
    )",
];

pub struct Library {
    pub root: PathBuf,
    pub conn: Connection,
}

fn err(e: impl Display) -> String {
    e.to_string()
}

pub fn create(root: &Path) -> Result<Library, String> {
    create_with(root, MIGRATIONS)
}

fn create_with(root: &Path, migrations: &[&str]) -> Result<Library, String> {
    let entries = fs::read_dir(root)
        .map_err(|e| format!("フォルダを読めません（{}、{e}）", root.display()))?;
    // 中身のあるフォルダをライブラリにするのは FR-103（フェーズ4）なので、ここでは受け付けない
    for entry in entries {
        if entry.map_err(err)?.file_name() != ".DS_Store" {
            return Err("空のフォルダを選んでください".into());
        }
    }
    let kura = root.join(KURA_DIR);
    let uncategorized = root.join(UNCATEGORIZED_DIR);
    let result = (|| {
        fs::create_dir(&kura).map_err(err)?;
        fs::create_dir(&uncategorized).map_err(err)?;
        connect(root, migrations)
    })();
    if result.is_err() {
        // 空だったフォルダに自分で作ったものだけを消す。_未分類 は空のときだけ消える
        let _ = fs::remove_dir_all(&kura);
        let _ = fs::remove_dir(&uncategorized);
    }
    result
}

pub fn open(root: &Path) -> Result<Library, String> {
    if !root.is_dir() {
        return Err(format!("ライブラリが見つかりません（{}）", root.display()));
    }
    if !root.join(KURA_DIR).is_dir() {
        return Err(format!(
            "このフォルダはライブラリではありません（{} に {KURA_DIR} がありません）",
            root.display()
        ));
    }
    connect(root, MIGRATIONS)
}

fn connect(root: &Path, migrations: &[&str]) -> Result<Library, String> {
    let mut conn = Connection::open(root.join(KURA_DIR).join("kura.db")).map_err(err)?;
    // WAL：取り込み中も一覧を読めるようにするため。FULL：電源断でも直前のコミットを失わないため
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
        .map_err(err)?;
    migrate(&mut conn, migrations)?;
    let mut lib = Library {
        root: root.to_path_buf(),
        conn,
    };
    for op in fileops::recover(&mut lib, &apply_op)? {
        // shortcut: ログに残すだけで画面には出さない。不整合を画面に出す差分検出（FR-104）で利用者に知らせる
        log::warn!("途中で止まった操作を後始末できません：{op:?}");
    }
    Ok(lib)
}

// 操作の種類ごとの DB の更新。ファイルを動かす操作を作るタスクで種類を足す
fn apply_op(_tx: &Transaction, op: &PendingOp) -> Result<(), String> {
    match op.kind.as_str() {
        // 登録に要る情報（ハッシュ、幅と高さなど）は予定に残していない。ファイルは置いたままにし、
        // 差分検出（FR-104）が新しいファイルとして取り込みと同じ扱いで登録する
        "import" => Ok(()),
        _ => Err(format!("未知の操作の種類です（{}）", op.kind)),
    }
}

fn migrate(conn: &mut Connection, migrations: &[&str]) -> Result<(), String> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)?;
    let current = current as usize;
    if current > migrations.len() {
        return Err(
            "このライブラリはアプリより新しい版で作られています。アプリを更新してください".into(),
        );
    }
    for (i, sql) in migrations.iter().enumerate().skip(current) {
        // user_version もトランザクションに含まれるので、失敗した版は丸ごと取り消される
        let tx = conn.transaction().map_err(err)?;
        tx.execute_batch(sql).map_err(err)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)
            .map_err(err)?;
        tx.commit().map_err(err)?;
    }
    Ok(())
}

pub fn location_warning(path: &Path) -> Option<String> {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // shortcut: パスだけで判定するので、iCloud の「デスクトップと書類」の同期は見分けられない。問題が出たら NSURL の ubiquitous 属性で判定する
    if path
        .to_string_lossy()
        .contains("/Library/Mobile Documents/")
    {
        return Some(
            "iCloud Drive の中のフォルダです。iCloud Drive に置いたライブラリは動作を保証しません"
                .into(),
        );
    }
    let cpath = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: cpath は NUL 終端の文字列で、stat は書き込み可能な構造体
    if unsafe { libc::statfs(cpath.as_ptr(), &mut stat) } == 0
        && stat.f_flags & libc::MNT_LOCAL as u32 == 0
    {
        return Some("ネットワークドライブの中のフォルダです。ネットワークドライブに置いたライブラリは動作を保証しません".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn 空のフォルダにライブラリを作ると管理フォルダとdbと未分類ができる() {
        let dir = tempfile::tempdir().unwrap();
        let lib = create(dir.path()).unwrap();

        assert_eq!(entries(dir.path()), [KURA_DIR, UNCATEGORIZED_DIR]);
        assert!(dir.path().join(".kura/kura.db").is_file());
        let mode: String = lib
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let sync: i64 = lib
            .conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 2); // FULL
        assert_eq!(user_version(&lib.conn), MIGRATIONS.len() as i64);
    }

    #[test]
    fn ds_storeだけのフォルダにもライブラリを作れる() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".DS_Store"), b"").unwrap();
        create(dir.path()).unwrap();
    }

    #[test]
    fn 空でないフォルダにはライブラリを作らず中身も変えない() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"image").unwrap();

        let err = create(dir.path()).err().unwrap();

        assert!(err.contains("空のフォルダ"), "{err}");
        assert_eq!(entries(dir.path()), ["a.jpg"]);
    }

    #[test]
    fn 作成済みのライブラリには重ねて作らない() {
        let dir = tempfile::tempdir().unwrap();
        create(dir.path()).unwrap();
        assert!(create(dir.path()).is_err());
    }

    #[test]
    fn 作成の途中で失敗したらフォルダを元の空の状態に戻す() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".DS_Store"), b"").unwrap();

        assert!(create_with(dir.path(), &["NOT SQL"]).is_err());

        assert_eq!(entries(dir.path()), [".DS_Store"]);
        create(dir.path()).unwrap();
    }

    #[test]
    fn 作成したライブラリをもう一度開ける() {
        let dir = tempfile::tempdir().unwrap();
        create(dir.path())
            .unwrap()
            .conn
            .execute_batch("CREATE TABLE t(name); INSERT INTO t VALUES ('ポーズ')")
            .unwrap();

        let lib = open(dir.path()).unwrap();

        let name: String = lib
            .conn
            .query_row("SELECT name FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "ポーズ");
        assert_eq!(lib.root, dir.path());
    }

    #[test]
    fn 存在しないフォルダを開くと見つからないと返す() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("外したドライブ/ライブラリ");

        let err = open(&missing).err().unwrap();

        assert!(err.contains("見つかりません"), "{err}");
        assert!(!missing.exists());
    }

    #[test]
    fn 管理フォルダのないフォルダは開かず中身も変えない() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"image").unwrap();

        let err = open(dir.path()).err().unwrap();

        assert!(err.contains("ライブラリではありません"), "{err}");
        assert_eq!(entries(dir.path()), ["a.jpg"]);
    }

    #[test]
    fn 古い版のdbを開くと残りのマイグレーションだけを流す() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, &["CREATE TABLE a(x)"]).unwrap();
        conn.execute("INSERT INTO a VALUES (1)", []).unwrap();

        migrate(&mut conn, &["CREATE TABLE a(x)", "CREATE TABLE b(y)"]).unwrap();

        assert_eq!(user_version(&conn), 2);
        let n: i64 = conn
            .query_row("SELECT count(*) FROM a", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn マイグレーションの途中で失敗したら成功した版までで止まる() {
        let mut conn = Connection::open_in_memory().unwrap();

        assert!(migrate(
            &mut conn,
            &["CREATE TABLE a(x)", "CREATE TABLE b(y); NOT SQL"]
        )
        .is_err());

        assert_eq!(user_version(&conn), 1);
        let b: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(b, 0);
    }

    #[test]
    fn アプリより新しい版のdbは変更せずにエラーにする() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 99").unwrap();

        let err = migrate(&mut conn, &["CREATE TABLE a(x)"]).err().unwrap();

        assert!(err.contains("新しい版"), "{err}");
        assert_eq!(user_version(&conn), 99);
    }

    #[test]
    fn icloud_driveの下を指定すると警告する() {
        let path = Path::new("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/資料");
        assert!(location_warning(path).unwrap().contains("iCloud Drive"));
    }

    #[test]
    fn 内蔵ディスクのフォルダには警告しない() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(location_warning(dir.path()), None);
    }
}
