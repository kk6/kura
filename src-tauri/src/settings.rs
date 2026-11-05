use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// アプリ全体の設定。アプリのデータフォルダに置き、どのライブラリを開いても同じ値を使う。
/// ライブラリの中身に結び付く状態（カテゴリの開閉）は、ライブラリの DB に置く
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// サイドバーでカテゴリを移すときに確認する（FR-412）
    pub confirm_category_move: bool,
    /// 一覧の列の幅の目安（FR-501）。範囲に収めるのは画面側
    pub thumb_width: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            confirm_category_move: true,
            thumb_width: 200,
        }
    }
}

/// ファイルがないか壊れていれば初期値を返す。足りない項目も初期値で埋める（後の版で項目を足したとき）
pub fn load(file: &Path) -> Settings {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(file: &Path, settings: &Settings) -> std::io::Result<()> {
    write_json(file, settings)
}

/// 書き込みの途中で止まっても前の内容が壊れないよう、別名に書いてから置き換える
pub fn write_json(file: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(&tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::category::tests::{lock, unlock};

    #[test]
    fn ファイルがなければ初期値() {
        let dir = tempfile::tempdir().unwrap();

        let s = load(&dir.path().join("settings.json"));

        assert_eq!(s, Settings::default());
        assert!(s.confirm_category_move);
        assert_eq!(s.thumb_width, 200);
    }

    #[test]
    fn 保存した値を読める() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app/settings.json");
        let s = Settings {
            confirm_category_move: false,
            thumb_width: 140,
        };

        save(&file, &s).unwrap();

        assert_eq!(load(&file), s);
    }

    #[test]
    fn 足りない項目は初期値で埋める() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, r#"{"thumb_width": 300, "unknown": 1}"#).unwrap();

        let s = load(&file);

        assert_eq!(s.thumb_width, 300);
        assert!(s.confirm_category_move);
    }

    #[test]
    fn 壊れたファイルは初期値として扱い次の保存で直す() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, "{壊れた").unwrap();

        assert_eq!(load(&file), Settings::default());
        save(&file, &Settings::default()).unwrap();
        assert_eq!(load(&file), Settings::default());
    }

    #[test]
    fn 保存に失敗しても前の値が残る() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let before = Settings {
            confirm_category_move: false,
            thumb_width: 120,
        };
        save(&file, &before).unwrap();
        if !lock(dir.path()) {
            return;
        }

        let r = save(&file, &Settings::default());
        unlock(dir.path());

        assert!(r.is_err());
        assert_eq!(load(&file), before);
    }
}
