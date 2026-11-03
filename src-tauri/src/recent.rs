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
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    // 書き込みの途中で止まっても前の一覧が壊れないよう、別名に書いてから置き換える
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(&list)?)?;
    fs::rename(&tmp, file)?;
    Ok(list)
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
}
