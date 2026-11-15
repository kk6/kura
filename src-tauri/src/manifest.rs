use std::fs;
use std::path::Path;

use serde::Deserialize;

/// `ml/model.json` の中身。モデルの名前・次元・ダウンロード元・スレッド数を置く1か所（NFR-11）
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Manifest {
    // タスク5の calc がワーカーに渡す
    #[allow(dead_code)]
    pub threads: u32,
    pub aspects: Vec<Aspect>,
}

/// 観点1つ。`aspect` と `model` は features.db の列に入る値
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Aspect {
    pub aspect: String,
    pub model: String,
    pub dim: usize,
    pub file: Option<ModelFile>,
}

/// ダウンロードするモデルのファイル。学習済みモデルを使わない観点にはない
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

pub fn read(path: &Path) -> Result<Manifest, String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("{} を読めません（{e}）", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} を読めません（{e}）", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 観点ごとのモデル名と次元とファイルを読む() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.json");
        fs::write(
            &path,
            r#"{
              "threads": 1,
              "aspects": [
                {
                  "aspect": "content",
                  "model": "siglip2-base-patch16-224",
                  "dim": 768,
                  "file": {
                    "name": "siglip2-base-patch16-224-vision.onnx",
                    "url": "https://example.test/vision.onnx",
                    "sha256": "abc",
                    "size": 12
                  }
                },
                { "aspect": "composition", "model": "gray16-edge4x8-v1", "dim": 384, "file": null }
              ]
            }"#,
        )
        .unwrap();

        let m = read(&path).unwrap();

        assert_eq!(m.threads, 1);
        assert_eq!(
            m.aspects[0],
            Aspect {
                aspect: "content".into(),
                model: "siglip2-base-patch16-224".into(),
                dim: 768,
                file: Some(ModelFile {
                    name: "siglip2-base-patch16-224-vision.onnx".into(),
                    url: "https://example.test/vision.onnx".into(),
                    sha256: "abc".into(),
                    size: 12,
                }),
            }
        );
        assert_eq!(
            (
                m.aspects[1].aspect.as_str(),
                m.aspects[1].dim,
                &m.aspects[1].file
            ),
            ("composition", 384, &None)
        );
    }

    #[test]
    fn ないファイルと壊れたファイルはエラーにする() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.json");
        assert!(read(&path).is_err());
        fs::write(&path, r#"{"threads": 1}"#).unwrap();
        assert!(read(&path).is_err());
    }
}
