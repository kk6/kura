use std::collections::HashMap;

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::features;
use crate::library::{err, Library};
use crate::manifest::{Aspect, Kind};

/// タスク14まで、類似度と基準にできるかはベクトルの観点だけで決める。ポーズを足しても 3a の検索は変わらない
fn vectors(aspects: &[Aspect]) -> Vec<Aspect> {
    aspects
        .iter()
        .filter(|a| a.kind == Kind::Vector)
        .cloned()
        .collect()
}

/// 基準画像に対する観点ごとの類似度。ids と scores の各配列は同じ長さ・同じ並び。aspects は model.json の並び
#[derive(Debug, Serialize)]
pub struct Similar {
    pub aspects: Vec<String>,
    pub ids: Vec<i64>,
    pub scores: Vec<Vec<f32>>,
    /// ゴミ箱でも「見つからない」でもなく、特徴量がそろっていない画像の数
    pub uncomputed: usize,
}

const UNCOMPUTED: &str = "この画像の特徴量はまだ計算していません";

/// 基準画像 id に対する、特徴量がそろった全画像の類似度を観点ごとに返す。
/// 値は基準画像を除いた全画像で平均0・標準偏差1にそろえる（5.6 の「重み」）
pub fn similar(lib: &mut Library, aspects: &[Aspect], id: i64) -> Result<Similar, String> {
    let aspects = &vectors(aspects)[..];
    hash_of(lib, id)?.ok_or("ゴミ箱か「見つからない」の画像、または無い画像です")?;
    // 類似画像検索を使ったことのないライブラリには features.db を作らない（設計メモ2章）
    if !features::path(&lib.root).exists() {
        return Err(UNCOMPUTED.into());
    }
    let images: Vec<(i64, String)> = {
        let mut stmt = lib
            .conn
            .prepare("SELECT id, hash FROM images WHERE deleted_at IS NULL AND missing_at IS NULL ORDER BY id")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)?
    };
    let loaded: Vec<HashMap<String, Vec<f32>>> = lib.with_features(|s| {
        aspects
            .iter()
            .map(|a| Ok(s.load(a)?.into_iter().collect()))
            .collect()
    })?;

    let mut ids = Vec::new();
    let mut rows: Vec<Vec<&[f32]>> = vec![Vec::new(); aspects.len()];
    let mut uncomputed = 0;
    for (i, hash) in &images {
        let found: Option<Vec<&[f32]>> =
            loaded.iter().map(|m| m.get(hash).map(|v| &v[..])).collect();
        match found {
            Some(vs) => {
                ids.push(*i);
                for (row, v) in rows.iter_mut().zip(vs) {
                    row.push(v);
                }
            }
            None => uncomputed += 1,
        }
    }
    let at = ids.iter().position(|i| *i == id).ok_or(UNCOMPUTED)?;
    let scores = rows
        .iter()
        .map(|row| standardize(row.iter().map(|v| dot(row[at], v)).collect(), at))
        .collect();
    Ok(Similar {
        aspects: aspects.iter().map(|a| a.aspect.clone()).collect(),
        ids,
        scores,
        uncomputed,
    })
}

/// id を基準に探せるか。ゴミ箱でも「見つからない」でもなく、今のモデルの全観点の特徴量がそろっている。
/// 画面が押す前に未計算を知るため、詳細パネルを読むたびに呼ぶ（5.6 の「入口と結果」）
pub fn ready(lib: &mut Library, aspects: &[Aspect], id: i64) -> Result<bool, String> {
    let aspects = &vectors(aspects)[..];
    let Some(hash) = hash_of(lib, id)? else {
        return Ok(false);
    };
    // 類似画像検索を使ったことのないライブラリには features.db を作らない（設計メモ2章）
    if !features::path(&lib.root).exists() {
        return Ok(false);
    }
    lib.with_features(|s| s.has(&hash, aspects))
}

/// ゴミ箱でも「見つからない」でもない画像のハッシュ
fn hash_of(lib: &Library, id: i64) -> Result<Option<String>, String> {
    lib.conn
        .query_row(
            "SELECT hash FROM images WHERE id = ?1 AND deleted_at IS NULL AND missing_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// skip（基準画像）を除いた値の平均と母標準偏差で、全部の値をそろえる。そろえられなければすべて0
fn standardize(raw: Vec<f32>, skip: usize) -> Vec<f32> {
    let n = (raw.len() - 1) as f64;
    let others = || {
        raw.iter()
            .enumerate()
            .filter(|(i, _)| *i != skip)
            .map(|(_, s)| *s as f64)
    };
    let mean = others().sum::<f64>() / n;
    let sd = (others().map(|s| (s - mean).powi(2)).sum::<f64>() / n).sqrt();
    // 対象が基準画像だけなら n が0で、sd は NaN になる
    if sd.is_nan() || sd == 0.0 {
        return vec![0.0; raw.len()];
    }
    raw.iter()
        .map(|s| ((*s as f64 - mean) / sd) as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use tempfile::TempDir;

    use super::*;
    use crate::features::tests::aspect;
    use crate::library;

    fn aspects() -> Vec<Aspect> {
        vec![aspect("content", "m1", 2), aspect("composition", "c1", 2)]
    }

    fn open() -> (TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        (dir, lib)
    }

    /// 画像を1枚足して id を返す。state は "" か "trash" か "missing"
    fn add(lib: &mut Library, hash: &str, state: &str) -> i64 {
        let (deleted, missing) = match state {
            "trash" => (Some(1), None),
            "missing" => (None, Some(1)),
            _ => (None, None),
        };
        lib.conn
            .execute(
                "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                    imported_at, registered_at, deleted_at, missing_at)
                 VALUES (?1, ?2, 1, 1, 1, 1, '#808080', 1, 1, ?3, ?4)",
                params![format!("{hash}.jpg"), hash, deleted, missing],
            )
            .unwrap();
        lib.conn.last_insert_rowid()
    }

    /// 長さ1の2次元ベクトル。角度（度）で向きを決める
    fn unit(deg: f32) -> [f32; 2] {
        let r = deg.to_radians();
        [r.cos(), r.sin()]
    }

    /// 全観点に同じ向きの特徴量を書く
    fn put(lib: &mut Library, hash: &str, deg: f32) {
        let a = aspects();
        let v = unit(deg);
        lib.with_features(|s| s.put_vectors(hash, &[(&a[0], &v[..]), (&a[1], &v[..])], 1))
            .unwrap();
    }

    fn image(lib: &mut Library, hash: &str, deg: f32) -> i64 {
        let id = add(lib, hash, "");
        put(lib, hash, deg);
        id
    }

    fn score(r: &Similar, aspect: usize, id: i64) -> f32 {
        let i = r.ids.iter().position(|x| *x == id).unwrap();
        r.scores[aspect][i]
    }

    #[test]
    fn 自分に近いベクトルの画像ほど値が大きい() {
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        let near = image(&mut lib, "near", 10.0);
        let mid = image(&mut lib, "mid", 60.0);
        let far = image(&mut lib, "far", 170.0);
        let r = similar(&mut lib, &aspects(), base).unwrap();
        assert_eq!(r.aspects, ["content", "composition"]);
        for a in 0..2 {
            assert!(score(&r, a, base) > score(&r, a, near));
            assert!(score(&r, a, near) > score(&r, a, mid));
            assert!(score(&r, a, mid) > score(&r, a, far));
        }
    }

    #[test]
    fn そろえた後は基準画像を除いて平均0で標準偏差1() {
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        for (i, deg) in [5.0, 30.0, 45.0, 90.0, 120.0, 175.0].iter().enumerate() {
            image(&mut lib, &format!("h{i}"), *deg);
        }
        let r = similar(&mut lib, &aspects(), base).unwrap();
        assert_eq!(r.ids.len(), 7);
        for a in 0..2 {
            let others: Vec<f64> = r
                .ids
                .iter()
                .zip(&r.scores[a])
                .filter(|(id, _)| **id != base)
                .map(|(_, s)| *s as f64)
                .collect();
            let n = others.len() as f64;
            let mean = others.iter().sum::<f64>() / n;
            let sd = (others.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / n).sqrt();
            assert!(mean.abs() < 1e-5, "平均 {mean}");
            assert!((sd - 1.0).abs() < 1e-5, "標準偏差 {sd}");
            // 基準画像の値も同じ式でそろえる。内積1は、ほかのどの画像よりも大きい
            assert!(others.iter().all(|s| (score(&r, a, base) as f64) > *s));
        }
    }

    #[test]
    fn 標準偏差が0のときと対象が基準画像だけのときはすべて0() {
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        let r = similar(&mut lib, &aspects(), base).unwrap();
        assert_eq!(r.ids, [base]);
        assert_eq!(r.scores, [vec![0.0], vec![0.0]]);

        image(&mut lib, "a", 40.0);
        image(&mut lib, "b", 40.0);
        let r = similar(&mut lib, &aspects(), base).unwrap();
        assert_eq!(r.ids.len(), 3);
        assert!(r.scores.iter().flatten().all(|s| *s == 0.0));
    }

    #[test]
    fn ゴミ箱と見つからないと未計算の画像はidsになくuncomputedが合う() {
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        let ok = image(&mut lib, "ok", 30.0);
        let trash = add(&mut lib, "trash", "trash");
        put(&mut lib, "trash", 10.0);
        let missing = add(&mut lib, "missing", "missing");
        put(&mut lib, "missing", 10.0);
        let none = add(&mut lib, "none", "");
        // ゴミ箱・「見つからない」の未計算は uncomputed に数えない
        add(&mut lib, "trash2", "trash");
        add(&mut lib, "missing2", "missing");
        let r = similar(&mut lib, &aspects(), base).unwrap();
        assert_eq!(r.ids, [base, ok]);
        for id in [trash, missing, none] {
            assert!(!r.ids.contains(&id));
        }
        assert_eq!(r.uncomputed, 1);
        assert!(r.scores.iter().all(|s| s.len() == r.ids.len()));
    }

    #[test]
    fn 観点の片方しかない画像は未計算として扱う() {
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        let half = add(&mut lib, "half", "");
        let a = aspects();
        lib.with_features(|s| s.put_vectors("half", &[(&a[0], &unit(10.0)[..])], 1))
            .unwrap();
        // 古いモデル名の行は、今のモデルの特徴量に数えない
        let old = add(&mut lib, "old", "");
        let stale = aspect("composition", "c0", 2);
        lib.with_features(|s| {
            s.put_vectors(
                "old",
                &[(&a[0], &unit(10.0)[..]), (&stale, &unit(10.0)[..])],
                1,
            )
        })
        .unwrap();
        let r = similar(&mut lib, &a, base).unwrap();
        assert_eq!(r.ids, [base]);
        assert!(!r.ids.contains(&half) && !r.ids.contains(&old));
        assert_eq!(r.uncomputed, 2);
    }

    #[test]
    fn 基準画像が未計算かゴミ箱か見つからないならerr() {
        let (_d, mut lib) = open();
        image(&mut lib, "ok", 0.0);
        let none = add(&mut lib, "none", "");
        let trash = add(&mut lib, "trash", "trash");
        put(&mut lib, "trash", 0.0);
        let missing = add(&mut lib, "missing", "missing");
        put(&mut lib, "missing", 0.0);
        for id in [none, trash, missing, 9999] {
            assert!(similar(&mut lib, &aspects(), id).is_err(), "id {id}");
        }
    }

    #[test]
    fn 特徴量のdbがないライブラリでは作らずにerr() {
        let (_d, mut lib) = open();
        let id = add(&mut lib, "a", "");
        assert!(similar(&mut lib, &aspects(), id).is_err());
        assert!(!crate::features::path(&lib.root).exists());
    }

    #[test]
    fn 特徴量がそろった画像だけ基準にできる() {
        let (_d, mut lib) = open();
        let ok = image(&mut lib, "ok", 0.0);
        let none = add(&mut lib, "none", "");
        let half = add(&mut lib, "half", "");
        let a = aspects();
        lib.with_features(|s| s.put_vectors("half", &[(&a[0], &unit(0.0)[..])], 1))
            .unwrap();
        let trash = add(&mut lib, "trash", "trash");
        put(&mut lib, "trash", 0.0);
        let missing = add(&mut lib, "missing", "missing");
        put(&mut lib, "missing", 0.0);

        assert!(ready(&mut lib, &a, ok).unwrap());
        for id in [none, half, trash, missing, 9999] {
            assert!(!ready(&mut lib, &a, id).unwrap(), "id {id}");
        }
    }

    #[test]
    fn 特徴量のdbがないライブラリでは作らずに基準にできない() {
        let (_d, mut lib) = open();
        let id = add(&mut lib, "a", "");
        assert!(!ready(&mut lib, &aspects(), id).unwrap());
        assert!(!crate::features::path(&lib.root).exists());
    }

    #[test]
    fn 構図がすべて0の単色の画像は構図の値がほかの画像と同じに並ぶ() {
        // 単色の画像は構図のベクトルが0で、どの画像とも内積0になる（設計メモ1章）
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        let flat = add(&mut lib, "flat", "");
        let a = aspects();
        lib.with_features(|s| {
            s.put_vectors(
                "flat",
                &[(&a[0], &unit(20.0)[..]), (&a[1], &[0.0, 0.0][..])],
                1,
            )
        })
        .unwrap();
        let ortho = image(&mut lib, "ortho", 90.0);
        // 内積の散らばりを作る。2枚だけだと、cos(90°) の丸め誤差が標準偏差で1まで広がる
        image(&mut lib, "mid", 45.0);
        let r = similar(&mut lib, &a, base).unwrap();
        assert!(r.ids.contains(&flat));
        assert!((score(&r, 1, flat) - score(&r, 1, ortho)).abs() < 1e-5);
    }

    /// NFR-03 の計測。`cargo test --release 類似度の2万件の計測 -- --ignored --nocapture` で流す
    #[test]
    #[ignore]
    fn 類似度の2万件の計測() {
        const N: usize = 20_000;
        let a = vec![
            aspect("content", "siglip2-base-patch16-224", 768),
            aspect("composition", "gray16-edge4x8-v1", 384),
        ];
        let (_d, mut lib) = open();
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut random = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / (1u64 << 24) as f32 - 0.5
        };
        let mut unit = |dim: usize| {
            let v: Vec<f32> = (0..dim).map(|_| random()).collect();
            let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            v.into_iter().map(|x| x / n).collect::<Vec<f32>>()
        };
        let tx = lib.conn.unchecked_transaction().unwrap();
        for i in 0..N {
            tx.execute(
                "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                    imported_at, registered_at)
                 VALUES (?1, ?2, 1, 1, 1, 1, '#808080', 1, 1)",
                params![format!("{i}.jpg"), format!("h{i}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        for i in 0..N {
            let (c, p) = (unit(768), unit(384));
            lib.with_features(|s| {
                s.put_vectors(&format!("h{i}"), &[(&a[0], &c[..]), (&a[1], &p[..])], 1)
            })
            .unwrap();
        }
        let size = std::fs::metadata(crate::features::path(&lib.root))
            .unwrap()
            .len();
        let mut times = Vec::new();
        for run in 0..5 {
            let start = std::time::Instant::now();
            let r = similar(&mut lib, &a, 1 + run).unwrap();
            let json = serde_json::to_string(&r).unwrap();
            times.push(start.elapsed());
            assert_eq!(r.ids.len(), N);
            eprintln!(
                "{run}回目：{:?}（JSON {}バイト）",
                times[run as usize],
                json.len()
            );
        }
        eprintln!("features.db：{}バイト", size);
    }

    #[test]
    fn ポーズの観点があっても類似度と基準にできるかは内容と構図だけで決める() {
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        let near = image(&mut lib, "near", 10.0);
        image(&mut lib, "far", 170.0);
        let mut a = aspects();
        a.push(crate::features::tests::pose_aspect("p1", 51));

        let r = similar(&mut lib, &a, base).unwrap();

        assert_eq!(r.aspects, ["content", "composition"]);
        assert_eq!(r.ids.len(), 3);
        assert_eq!(r.uncomputed, 0);
        assert!(score(&r, 0, near) > 0.0);
        assert!(ready(&mut lib, &a, base).unwrap());
    }
}
