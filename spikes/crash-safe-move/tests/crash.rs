use std::path::Path;
use std::process::{Command, Output};

fn run(lib: &Path, args: &[&str], crash_at: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_crash-safe-move"));
    cmd.arg(args[0]).arg(lib).args(&args[1..]);
    if let Some(p) = crash_at {
        cmd.env("KURA_CRASH_AT", p);
    }
    cmd.output().unwrap()
}

/// ライブラリ内で中身が `content` のファイルの数（.kura を除く）
fn copies_of(lib: &Path, content: &[u8]) -> usize {
    ["座り", "立ち"]
        .iter()
        .flat_map(|c| std::fs::read_dir(lib.join(c)).unwrap())
        .filter(|e| std::fs::read(e.as_ref().unwrap().path()).unwrap() == content)
        .count()
}

fn scenario(crash_at: Option<&str>) -> (bool, bool) {
    let dir = tempfile::tempdir().unwrap();
    let lib = dir.path().join("lib");
    assert!(run(&lib, &["init"], None).status.success());

    let moved = run(&lib, &["move", "1", "立ち"], crash_at);
    assert_eq!(moved.status.success(), crash_at.is_none());

    // どこで止まっても、画像はちょうど1つ残り、移動先の同名ファイルは上書きされない
    assert_eq!(copies_of(&lib, b"dummy image a"), 1);
    assert_eq!(std::fs::read(lib.join("立ち/a.jpg")).unwrap(), b"dummy image b");

    let inconsistent_before = !run(&lib, &["check"], None).status.success();
    assert!(run(&lib, &["recover"], None).status.success());
    let check_after = run(&lib, &["check"], None);
    assert!(check_after.status.success(), "{}", String::from_utf8_lossy(&check_after.stdout));
    (inconsistent_before, lib.join("立ち/a (2).jpg").exists())
}

#[test]
fn completes_without_crash() {
    assert_eq!(scenario(None), (false, true));
}

#[test]
fn crash_after_journal_rolls_back() {
    // 予定だけが残る → check が検出し、recover が取り消す（ファイルは移動元のまま）
    assert_eq!(scenario(Some("after_journal")), (true, false));
}

#[test]
fn crash_after_rename_rolls_forward() {
    // ファイルは移動済み、DBは移動前 → check が検出し、recover がDBを移動先に合わせる
    assert_eq!(scenario(Some("after_rename")), (true, true));
}

#[test]
fn crash_before_commit_rolls_forward() {
    // 更新のトランザクションは捨てられ after_rename と同じ状態になる
    assert_eq!(scenario(Some("before_commit")), (true, true));
}
