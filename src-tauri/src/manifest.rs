use std::fs;
use std::path::Path;

use serde::Deserialize;

/// `ml/model.json` の中身。モデルの名前・次元・ダウンロード元・スレッド数を置く1か所（NFR-11）
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Manifest {
    // ワーカーが model.json から自分で読む。Rust は形を確かめるためだけに読む
    #[allow(dead_code)]
    pub threads: u32,
    pub aspects: Vec<Aspect>,
}

/// 観点1つ。`aspect` と `model` は features.db の列に入る値
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Aspect {
    pub aspect: String,
    pub model: String,
    pub kind: Kind,
    /// vector はベクトルの長さ、pose は1人分の数の個数
    pub dim: usize,
    /// 学習済みモデルを使わない観点では空。pose は「人物の検出、骨格」の順
    pub files: Vec<ModelFile>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Vector,
    Pose,
}

/// models/ に置くモデルのファイル。name、sha256、size は置く .onnx のもの
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// あれば url は zip を指し、member を取り出して置く
    #[serde(default)]
    pub archive: Option<Archive>,
}

/// ダウンロードする zip。sha256 と size は zip のもの
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Archive {
    pub member: String,
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

    fn write(text: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.json");
        fs::write(&path, text).unwrap();
        (dir, path)
    }

    #[test]
    fn 観点ごとの種類と次元とファイルとzipを読む() {
        let (_d, path) = write(
            r#"{
              "threads": 1,
              "aspects": [
                {
                  "aspect": "content",
                  "model": "siglip2-base-patch16-224",
                  "kind": "vector",
                  "dim": 768,
                  "files": [
                    {
                      "name": "siglip2-base-patch16-224-vision.onnx",
                      "url": "https://example.test/vision.onnx",
                      "sha256": "abc",
                      "size": 12
                    }
                  ]
                },
                { "aspect": "composition", "model": "gray16-edge4x8-v1", "kind": "vector", "dim": 384, "files": [] },
                {
                  "aspect": "pose",
                  "model": "pose-v1",
                  "kind": "pose",
                  "dim": 51,
                  "files": [
                    {
                      "name": "det.onnx",
                      "url": "https://example.test/det.zip",
                      "sha256": "def",
                      "size": 30,
                      "archive": { "member": "a/end2end.onnx", "sha256": "123", "size": 20 }
                    }
                  ]
                }
              ]
            }"#,
        );

        let m = read(&path).unwrap();

        assert_eq!(m.threads, 1);
        assert_eq!(
            m.aspects[0],
            Aspect {
                aspect: "content".into(),
                model: "siglip2-base-patch16-224".into(),
                kind: Kind::Vector,
                dim: 768,
                files: vec![ModelFile {
                    name: "siglip2-base-patch16-224-vision.onnx".into(),
                    url: "https://example.test/vision.onnx".into(),
                    sha256: "abc".into(),
                    size: 12,
                    archive: None,
                }],
            }
        );
        assert_eq!(
            (
                m.aspects[1].kind,
                m.aspects[1].dim,
                m.aspects[1].files.len()
            ),
            (Kind::Vector, 384, 0)
        );
        assert_eq!((m.aspects[2].kind, m.aspects[2].dim), (Kind::Pose, 51));
        assert_eq!(
            m.aspects[2].files[0].archive,
            Some(Archive {
                member: "a/end2end.onnx".into(),
                sha256: "123".into(),
                size: 20,
            })
        );
    }

    #[test]
    fn 知らない種類はエラーにする() {
        let (_d, path) = write(
            r#"{"threads": 1, "aspects": [{"aspect": "x", "model": "m", "kind": "graph", "dim": 1, "files": []}]}"#,
        );
        assert!(read(&path).is_err());
    }

    #[test]
    fn リポジトリのmodel_jsonを読める() {
        let m = read(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../ml/model.json"
        )))
        .unwrap();
        let kinds: Vec<_> = m
            .aspects
            .iter()
            .map(|a| (a.aspect.as_str(), a.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("content", Kind::Vector),
                ("composition", Kind::Vector),
                ("pose", Kind::Pose)
            ]
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
