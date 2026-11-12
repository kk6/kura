use std::fs;
use std::path::{Path, PathBuf};

const MAX: usize = 10;

// ライブラリの外（アプリのデータフォルダ）に置くので、外付けドライブが外れていても読める
pub fn load(file: &Path) -> Vec<PathBuf> {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn push(file: &Path, library: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut list = load(file);
    list.retain(|p| p != library);
    list.insert(0, library.to_path_buf());
    list.truncate(MAX);
    crate::settings::write_json(file, &list)?;
    Ok(list)
}

/// 見つからないライブラリを一覧から外す（FR-106）。フォルダには触れない
pub fn remove(file: &Path, library: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut list = load(file);
    list.retain(|p| p != library);
    crate::settings::write_json(file, &list)?;
    Ok(list)
}

/// 一覧のうち、フォルダが見つからないもの。開くとき（library::open）と同じ判定にする
pub fn missing(list: &[PathBuf]) -> Vec<PathBuf> {
    list.iter().filter(|p| !p.is_dir()).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn 一覧のファイルがなければ空() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(&dir.path().join("recent.json")).is_empty());
    }

    #[test]
    fn 開いたライブラリを先頭に足し重複は除く() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app/recent.json");

        push(&file, Path::new("/a")).unwrap();
        push(&file, Path::new("/b")).unwrap();
        push(&file, Path::new("/a")).unwrap();

        assert_eq!(load(&file), [PathBuf::from("/a"), PathBuf::from("/b")]);
    }

    #[test]
    fn 一覧は上限の件数までにする() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recent.json");
        for i in 0..MAX + 3 {
            push(&file, Path::new(&format!("/{i}"))).unwrap();
        }

        let list = load(&file);

        assert_eq!(list.len(), MAX);
        assert_eq!(list[0], PathBuf::from(format!("/{}", MAX + 2)));
    }

    #[test]
    fn 存在しないパスも一覧に残す() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recent.json");
        push(&file, Path::new("/Volumes/外したドライブ/ライブラリ")).unwrap();
        push(&file, dir.path()).unwrap();

        assert_eq!(load(&file).len(), 2);
    }

    #[test]
    fn 壊れた一覧のファイルは空として扱い次の保存で直す() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recent.json");
        fs::write(&file, "{壊れた").unwrap();

        assert!(load(&file).is_empty());
        push(&file, Path::new("/a")).unwrap();
        assert_eq!(load(&file), [PathBuf::from("/a")]);
    }

    #[test]
    fn 一覧から外すと履歴だけが変わりフォルダは残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recent.json");
        let library = dir.path().join("ライブラリ");
        fs::create_dir(&library).unwrap();
        push(&file, &library).unwrap();
        push(&file, Path::new("/Volumes/外したドライブ/ライブラリ")).unwrap();

        let list = remove(&file, Path::new("/Volumes/外したドライブ/ライブラリ")).unwrap();

        assert_eq!(list, [library.clone()]);
        assert_eq!(load(&file), [library.clone()]);
        assert!(library.is_dir());
        // 開き直せば一覧に戻る
        push(&file, Path::new("/Volumes/外したドライブ/ライブラリ")).unwrap();
        assert_eq!(load(&file).len(), 2);
    }

    #[test]
    fn フォルダがないライブラリだけを見つからないとする() {
        let dir = tempfile::tempdir().unwrap();
        let gone = PathBuf::from("/Volumes/外したドライブ/ライブラリ");
        assert_eq!(missing(&[dir.path().to_path_buf(), gone.clone()]), [gone]);
    }
}
