use std::collections::{BTreeMap, HashMap};

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::features;
use crate::library::{err, Library};
use crate::manifest::{Aspect, Kind};
use crate::worker::{Pose, PoseStatus};

/// 結果に出すか（uncomputed）と基準にできるかは、ベクトルの観点だけで決める。
/// ポーズのない画像（人物なし、未計算）も内容と構図で探せるようにするため（5.6 の「重み」）
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
    /// ゴミ箱でも「見つからない」でもなく、内容と構図の特徴量がそろっていない画像の数
    pub uncomputed: usize,
    /// 比べなかった観点と、その理由。aspects と scores には入れない
    pub skipped: BTreeMap<String, Skip>,
}

/// ポーズの観点を比べなかった理由。帯の「体の姿勢」のスライダーに出す
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Skip {
    /// その観点のモデルのファイルがない
    MissingModels,
    /// 基準画像のポーズをまだ計算していない
    Uncomputed,
    /// 基準画像に人物がいない
    #[serde(rename = "none")]
    NoPerson,
    /// 基準画像の人物の関節が足りない
    Few,
}

const UNCOMPUTED: &str = "この画像の特徴量はまだ計算していません";

/// 基準画像 id に対する、内容と構図の特徴量がそろった全画像の類似度を観点ごとに返す。
/// 値は基準画像を除いた全画像で平均0・標準偏差1にそろえる（5.6 の「重み」）。
/// ポーズは基準画像にポーズがあり、missing（モデルのファイルが欠けた観点）に入っていないときだけ比べる
pub fn similar(
    lib: &mut Library,
    aspects: &[Aspect],
    id: i64,
    missing: &[String],
) -> Result<Similar, String> {
    let vecs = &vectors(aspects)[..];
    let base_hash =
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
        vecs.iter()
            .map(|a| Ok(s.load(a)?.into_iter().collect()))
            .collect()
    })?;

    let mut ids = Vec::new();
    let mut hashes = Vec::new();
    let mut rows: Vec<Vec<&[f32]>> = vec![Vec::new(); vecs.len()];
    let mut uncomputed = 0;
    for (i, hash) in &images {
        let found: Option<Vec<&[f32]>> =
            loaded.iter().map(|m| m.get(hash).map(|v| &v[..])).collect();
        match found {
            Some(vs) => {
                ids.push(*i);
                hashes.push(hash);
                for (row, v) in rows.iter_mut().zip(vs) {
                    row.push(v);
                }
            }
            None => uncomputed += 1,
        }
    }
    let at = ids.iter().position(|i| *i == id).ok_or(UNCOMPUTED)?;
    let mut names: Vec<String> = vecs.iter().map(|a| a.aspect.clone()).collect();
    let mut scores: Vec<Vec<f32>> = rows
        .iter()
        .map(|row| standardize(row.iter().map(|v| Some(dot(row[at], v))).collect(), at))
        .collect();

    let mut skipped = BTreeMap::new();
    for a in aspects.iter().filter(|a| a.kind == Kind::Pose) {
        if a.dim != 51 {
            return Err(format!("{} は COCO の17点のポーズではありません", a.aspect));
        }
        if missing.contains(&a.aspect) {
            skipped.insert(a.aspect.clone(), Skip::MissingModels);
            continue;
        }
        let poses: HashMap<String, Pose> = lib
            .with_features(|s| s.load_poses(a))?
            .into_iter()
            .collect();
        let base = match poses.get(&base_hash).map(|p| p.status) {
            Some(PoseStatus::Ok) => &poses[&base_hash].people,
            Some(PoseStatus::Few) => {
                skipped.insert(a.aspect.clone(), Skip::Few);
                continue;
            }
            Some(PoseStatus::None) => {
                skipped.insert(a.aspect.clone(), Skip::NoPerson);
                continue;
            }
            None => {
                skipped.insert(a.aspect.clone(), Skip::Uncomputed);
                continue;
            }
        };
        // ポーズのない画像（人物なし、関節不足、未計算、比べられる組がない）は None。そろえた後の平均0になる
        let raw = hashes
            .iter()
            .map(|h| poses.get(*h).and_then(|p| pose_similarity(base, &p.people)))
            .collect();
        names.push(a.aspect.clone());
        scores.push(standardize(raw, at));
    }
    Ok(Similar {
        aspects: names,
        ids,
        scores,
        uncomputed,
        skipped,
    })
}

/// 拡大表示に重ねる骨格（FR-606）。ポーズがなければ people は空で、skipped に理由を入れる
#[derive(Debug, PartialEq, Serialize)]
pub struct PoseOf {
    /// 人物ごとに COCO 17点の [x, y, スコア]。x、y はサムネイルの長い辺を1とした値
    pub people: Vec<Vec<f32>>,
    pub skipped: Option<Skip>,
}

/// id の画像の、今のモデルのポーズ。missing（モデルのファイルが欠けた観点）に入っていれば使わない
pub fn pose_of(
    lib: &mut Library,
    aspects: &[Aspect],
    id: i64,
    missing: &[String],
) -> Result<PoseOf, String> {
    let skip = |s| {
        Ok(PoseOf {
            people: Vec::new(),
            skipped: Some(s),
        })
    };
    let Some(a) = aspects.iter().find(|a| a.kind == Kind::Pose) else {
        return skip(Skip::MissingModels);
    };
    if missing.contains(&a.aspect) {
        return skip(Skip::MissingModels);
    }
    // 類似画像検索を使ったことのないライブラリには features.db を作らない（設計メモ2章）
    let Some(hash) = hash_of(lib, id)?.filter(|_| features::path(&lib.root).exists()) else {
        return skip(Skip::Uncomputed);
    };
    match lib.with_features(|s| s.pose(&hash, a))? {
        Some(p) if p.status == PoseStatus::Ok => Ok(PoseOf {
            people: p.people,
            skipped: None,
        }),
        Some(p) if p.status == PoseStatus::Few => skip(Skip::Few),
        Some(_) => skip(Skip::NoPerson),
        None => skip(Skip::Uncomputed),
    }
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

/// skip（基準画像）と None を除いた値の平均と母標準偏差で、値をそろえる。None は平均（0）にする。
/// そろえられなければすべて0
fn standardize(raw: Vec<Option<f32>>, skip: usize) -> Vec<f32> {
    let others = || {
        raw.iter()
            .enumerate()
            .filter(|(i, _)| *i != skip)
            .filter_map(|(_, s)| s.map(f64::from))
    };
    let n = others().count() as f64;
    let mean = others().sum::<f64>() / n;
    let sd = (others().map(|s| (s - mean).powi(2)).sum::<f64>() / n).sqrt();
    // 比べる画像がなければ n が0で、sd は NaN になる
    if sd.is_nan() || sd == 0.0 {
        return vec![0.0; raw.len()];
    }
    raw.iter()
        .map(|s| s.map_or(0.0, |s| ((s as f64 - mean) / sd) as f32))
        .collect()
}

/// これ未満のスコアの関節は見えないものとして比べない（5.6 の「ポーズ（3b）」）
const SEEN: f32 = 0.3;
/// 2人に共通に見えている関節がこれ未満なら比べない
const MIN_JOINTS: usize = 6;
/// COCO の17点の左右の組（目、耳、肩、肘、手首、股関節、膝、足首）を入れ替える並び
const FLIP: [usize; 17] = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];

/// 基準画像の人物と比べる側の人物の全部の組と、比べる側を左右反転した骨格のうち、一番近い値。
/// 比べられる組がなければ None
fn pose_similarity(base: &[Vec<f32>], other: &[Vec<f32>]) -> Option<f32> {
    base.iter()
        .flat_map(|a| {
            other.iter().flat_map(move |b| {
                [
                    person_similarity(a, b, false),
                    person_similarity(a, b, true),
                ]
            })
        })
        .flatten()
        .reduce(f32::max)
}

/// 1人分（x, y, スコア）×17 どうしの近さ。共通に見えている関節だけで重心を引いたコサイン類似度に、
/// a の見えている関節のうち比べた割合を掛ける。共通の関節が少ない組が不当に高くならないようにするため
fn person_similarity(a: &[f32], b: &[f32], mirror: bool) -> Option<f32> {
    let seen = |p: &[f32], j: usize| p[3 * j + 2] >= SEEN;
    let pairs: Vec<([f32; 2], [f32; 2])> = (0..17)
        .filter_map(|j| {
            let k = if mirror { FLIP[j] } else { j };
            // 反転した骨格は x の符号を変える。重心を引くので、どこを軸に反転しても同じ
            let bx = if mirror { -b[3 * k] } else { b[3 * k] };
            (seen(a, j) && seen(b, k)).then(|| ([a[3 * j], a[3 * j + 1]], [bx, b[3 * k + 1]]))
        })
        .collect();
    if pairs.len() < MIN_JOINTS {
        return None;
    }
    let n = pairs.len() as f32;
    let center = |side: usize| {
        let pick = |p: &([f32; 2], [f32; 2])| if side == 0 { p.0 } else { p.1 };
        let c = pairs
            .iter()
            .map(pick)
            .fold([0.0, 0.0], |s, v| [s[0] + v[0], s[1] + v[1]]);
        let c = [c[0] / n, c[1] / n];
        pairs
            .iter()
            .flat_map(|p| [pick(p)[0] - c[0], pick(p)[1] - c[1]])
            .collect::<Vec<f32>>()
    };
    let (x, y) = (center(0), center(1));
    let cos = dot(&x, &y) / (dot(&x, &x).sqrt() * dot(&y, &y).sqrt() + 1e-9);
    let visible = (0..17).filter(|j| seen(a, *j)).count() as f32;
    Some(cos * n / visible)
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use tempfile::TempDir;

    use super::*;
    use crate::features::tests::aspect;
    use crate::library;
    use crate::worker::PoseStatus;

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
        let r = similar(&mut lib, &aspects(), base, &[]).unwrap();
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
        let r = similar(&mut lib, &aspects(), base, &[]).unwrap();
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
        let r = similar(&mut lib, &aspects(), base, &[]).unwrap();
        assert_eq!(r.ids, [base]);
        assert_eq!(r.scores, [vec![0.0], vec![0.0]]);

        image(&mut lib, "a", 40.0);
        image(&mut lib, "b", 40.0);
        let r = similar(&mut lib, &aspects(), base, &[]).unwrap();
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
        let r = similar(&mut lib, &aspects(), base, &[]).unwrap();
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
        let r = similar(&mut lib, &a, base, &[]).unwrap();
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
            assert!(similar(&mut lib, &aspects(), id, &[]).is_err(), "id {id}");
        }
    }

    #[test]
    fn 特徴量のdbがないライブラリでは作らずにerr() {
        let (_d, mut lib) = open();
        let id = add(&mut lib, "a", "");
        assert!(similar(&mut lib, &aspects(), id, &[]).is_err());
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
        let r = similar(&mut lib, &a, base, &[]).unwrap();
        assert!(r.ids.contains(&flat));
        assert!((score(&r, 1, flat) - score(&r, 1, ortho)).abs() < 1e-5);
    }

    /// NFR-03 の計測。`cargo test --release 類似度の2万件の計測 -- --ignored --nocapture` で流す。
    /// ポーズは6割を1〜3人の「ポーズあり」、2割を人物なし、1割を関節不足、1割を未計算にする
    #[test]
    #[ignore]
    fn 類似度の2万件の計測() {
        const N: usize = 20_000;
        let a = vec![
            aspect("content", "siglip2-base-patch16-224", 768),
            aspect("composition", "gray16-edge4x8-v1", 384),
            crate::features::tests::pose_aspect("rtmpose-m-body7-yolox-tiny-humanart-v1", 51),
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
            let people: Vec<Vec<f32>> = (0..1 + i % 3)
                .map(|_| unit(51).into_iter().map(|x| x * 4.0 + 0.5).collect())
                .collect();
            let v = match i % 10 {
                0..=5 => crate::features::tests::pose(
                    PoseStatus::Ok,
                    &people.iter().map(|p| &p[..]).collect::<Vec<_>>(),
                ),
                6 | 7 => crate::features::tests::pose(PoseStatus::None, &[]),
                8 => crate::features::tests::pose(PoseStatus::Few, &[]),
                _ => continue,
            };
            lib.with_features(|s| s.put(&format!("h{i}"), &[(&a[2], &v)], 1))
                .unwrap();
        }
        let size = std::fs::metadata(crate::features::path(&lib.root))
            .unwrap()
            .len();
        for run in 0..5 {
            let start = std::time::Instant::now();
            let n = lib.with_features(|s| s.load_poses(&a[2])).unwrap().len();
            eprintln!("load_poses {run}回目：{:?}（{n}行）", start.elapsed());
        }
        let mut times = Vec::new();
        for run in 0..5 {
            let start = std::time::Instant::now();
            let r = similar(&mut lib, &a, 1 + run, &[]).unwrap();
            let json = serde_json::to_string(&r).unwrap();
            times.push(start.elapsed());
            assert_eq!(r.ids.len(), N);
            assert_eq!(r.aspects.len(), 3);
            eprintln!(
                "{run}回目：{:?}（JSON {}バイト）",
                times[run as usize],
                json.len()
            );
        }
        eprintln!("features.db：{}バイト", size);
    }

    // ここからポーズ（5.6 の「ポーズ（3b）」）

    /// 立って左腕（画像の右側）だけを頭の上に上げた人。COCO の17点、座標は長い辺で割った値
    const RAISE: [[f32; 2]; 17] = [
        [0.50, 0.10],
        [0.52, 0.08],
        [0.48, 0.08],
        [0.54, 0.09],
        [0.46, 0.09],
        [0.58, 0.20],
        [0.42, 0.20],
        [0.64, 0.12],
        [0.38, 0.30],
        [0.66, 0.02],
        [0.37, 0.40],
        [0.55, 0.45],
        [0.45, 0.45],
        [0.56, 0.62],
        [0.44, 0.62],
        [0.57, 0.80],
        [0.43, 0.80],
    ];

    /// 1人分（x, y, スコア）×17。hidden の関節はスコアを0.3未満にする
    fn person(xy: &[[f32; 2]; 17], hidden: &[usize]) -> Vec<f32> {
        (0..17)
            .flat_map(|j| {
                let s = if hidden.contains(&j) { 0.1 } else { 0.9 };
                [xy[j][0], xy[j][1], s]
            })
            .collect()
    }

    /// 左右反転した写真に写る人。x を反転し、左右の関節を入れ替える
    fn mirrored(xy: &[[f32; 2]; 17]) -> [[f32; 2]; 17] {
        let mut out = [[0.0; 2]; 17];
        for (j, k) in FLIP.iter().enumerate() {
            out[j] = [1.0 - xy[*k][0], xy[*k][1]];
        }
        out
    }

    /// 横にした人（寝ている人）。立っている人とは似ていないとする
    fn lying(xy: &[[f32; 2]; 17]) -> [[f32; 2]; 17] {
        xy.map(|[x, y]| [y, 1.0 - x])
    }

    /// 片方の腕の上げ方だけ変えた人
    fn arm(xy: &[[f32; 2]; 17], elbow: [f32; 2], wrist: [f32; 2]) -> [[f32; 2]; 17] {
        let mut out = *xy;
        out[7] = elbow;
        out[9] = wrist;
        out
    }

    fn close(a: Option<f32>, b: f32) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-4)
    }

    #[test]
    fn 同じポーズは1で大きさと位置によらない() {
        let a = person(&RAISE, &[]);
        let moved = person(&RAISE.map(|[x, y]| [x * 0.5 + 0.3, y * 0.5 + 0.2]), &[]);
        assert!(close(pose_similarity(&[a.clone()], &[a.clone()]), 1.0));
        assert!(close(pose_similarity(&[a], &[moved]), 1.0));
    }

    #[test]
    fn 左右反転したポーズは同じポーズとみなす() {
        let a = person(&RAISE, &[]);
        let m = person(&mirrored(&RAISE), &[]);
        assert!(close(pose_similarity(&[a.clone()], &[m]), 1.0));
        // 反転しても違うポーズは違う
        let down = person(&arm(&RAISE, [0.62, 0.30], [0.63, 0.40]), &[]);
        assert!(pose_similarity(&[a], &[down]).unwrap() < 0.99);
    }

    #[test]
    fn 回転はそろえないので寝ている人は立っている人と似ていない() {
        let a = person(&RAISE, &[]);
        let near = person(&arm(&RAISE, [0.66, 0.16], [0.70, 0.08]), &[]);
        let lie = person(&lying(&RAISE), &[]);
        let near = pose_similarity(&[a.clone()], &[near]).unwrap();
        let lie = pose_similarity(&[a], &[lie]).unwrap();
        assert!(near > lie, "{near} {lie}");
    }

    #[test]
    fn 複数人の画像は全員の組のうち一番近い組の値() {
        let a = person(&RAISE, &[]);
        let other = person(&lying(&RAISE), &[]);
        // 比べる側の2人目が同じポーズ
        assert!(close(
            pose_similarity(&[a.clone()], &[other.clone(), a.clone()]),
            1.0
        ));
        // 基準の側の2人目が同じポーズ（反転）
        let m = person(&mirrored(&RAISE), &[]);
        assert!(close(
            pose_similarity(&[other.clone(), m], &[a.clone()]),
            1.0
        ));
        let one = pose_similarity(&[a.clone()], &[other.clone()]).unwrap();
        assert!(close(pose_similarity(&[other], &[a]), one));
    }

    #[test]
    fn 両方で見えている関節だけを比べ基準の見えている関節のうち比べた割合を掛ける() {
        let a = person(&RAISE, &[]);
        // 比べる側で脚の4点が見えない。見えない関節の座標がでたらめでも値は変わらない
        let mut legs = RAISE;
        for j in [13, 14, 15, 16] {
            legs[j] = [9.0, -9.0];
        }
        let b = person(&legs, &[13, 14, 15, 16]);
        assert!(close(
            pose_similarity(&[a.clone()], &[b.clone()]),
            13.0 / 17.0
        ));
        // 基準の側で見えない関節は割合の分母に入れない
        let a13 = person(&RAISE, &[13, 14, 15, 16]);
        assert!(close(pose_similarity(&[a13], &[a]), 1.0));
    }

    #[test]
    fn 共通に見えている関節が6点未満の組は比べない() {
        let a = person(&RAISE, &[]);
        let five = person(&RAISE, &[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        assert_eq!(pose_similarity(&[a.clone()], &[five]), None);
        let six = person(&RAISE, &[6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        assert!(close(pose_similarity(&[a], &[six]), 6.0 / 17.0));
    }

    fn pose_aspects() -> Vec<Aspect> {
        let mut a = aspects();
        a.push(crate::features::tests::pose_aspect("p1", 51));
        a
    }

    /// 内容と構図は全部同じ向きにして、ポーズだけで差が出るようにする
    fn posed(lib: &mut Library, hash: &str, status: PoseStatus, people: &[Vec<f32>]) -> i64 {
        let id = image(lib, hash, 0.0);
        let a = pose_aspects();
        let people: Vec<&[f32]> = people.iter().map(|p| &p[..]).collect();
        let v = crate::features::tests::pose(status, &people);
        lib.with_features(|s| s.put(hash, &[(&a[2], &v)], 1))
            .unwrap();
        id
    }

    #[test]
    fn 似たポーズと反転したポーズほど値が大きく人物のいない画像は0() {
        let (_d, mut lib) = open();
        let a = pose_aspects();
        let base = posed(&mut lib, "base", PoseStatus::Ok, &[person(&RAISE, &[])]);
        let same = posed(&mut lib, "same", PoseStatus::Ok, &[person(&RAISE, &[])]);
        let flip = posed(
            &mut lib,
            "flip",
            PoseStatus::Ok,
            &[person(&mirrored(&RAISE), &[])],
        );
        let near = posed(
            &mut lib,
            "near",
            PoseStatus::Ok,
            &[person(&arm(&RAISE, [0.66, 0.16], [0.70, 0.08]), &[])],
        );
        let lie = posed(
            &mut lib,
            "lie",
            PoseStatus::Ok,
            &[person(&lying(&RAISE), &[])],
        );
        let none = posed(&mut lib, "none", PoseStatus::None, &[]);
        let few = posed(&mut lib, "few", PoseStatus::Few, &[]);
        // ポーズの行がない（未計算、モデルがない）画像も、ポーズがない画像と同じく0
        let unposed = image(&mut lib, "unposed", 0.0);

        let r = similar(&mut lib, &a, base, &[]).unwrap();

        assert_eq!(r.aspects, ["content", "composition", "pose"]);
        assert!(r.skipped.is_empty());
        assert_eq!(r.ids.len(), 8);
        assert_eq!(r.uncomputed, 0);
        assert!((score(&r, 2, same) - score(&r, 2, flip)).abs() < 1e-4);
        assert!(score(&r, 2, flip) > score(&r, 2, near));
        assert!(score(&r, 2, near) > score(&r, 2, lie));
        for id in [none, few, unposed] {
            assert_eq!(score(&r, 2, id), 0.0, "id {id}");
        }
        // 平均と標準偏差は、基準を除いたポーズのある画像だけで計算する
        let ok: Vec<f64> = [same, flip, near, lie]
            .iter()
            .map(|id| score(&r, 2, *id) as f64)
            .collect();
        let mean = ok.iter().sum::<f64>() / 4.0;
        let sd = (ok.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / 4.0).sqrt();
        assert!(mean.abs() < 1e-5, "平均 {mean}");
        assert!((sd - 1.0).abs() < 1e-5, "標準偏差 {sd}");
        // 人物のいない画像は、似たポーズの下、似ていないポーズの上に来る（末尾に固まらない）
        assert!(score(&r, 2, near) > 0.0 && score(&r, 2, lie) < 0.0);
    }

    #[test]
    fn ポーズはあるが共通に見えている関節が足りない画像も0で平均に入れない() {
        let (_d, mut lib) = open();
        let a = pose_aspects();
        let base = posed(&mut lib, "base", PoseStatus::Ok, &[person(&RAISE, &[])]);
        let hidden: Vec<usize> = (5..17).collect();
        let face = posed(&mut lib, "face", PoseStatus::Ok, &[person(&RAISE, &hidden)]);
        posed(&mut lib, "same", PoseStatus::Ok, &[person(&RAISE, &[])]);
        posed(
            &mut lib,
            "lie",
            PoseStatus::Ok,
            &[person(&lying(&RAISE), &[])],
        );
        let r = similar(&mut lib, &a, base, &[]).unwrap();
        assert_eq!(score(&r, 2, face), 0.0);
        let others: Vec<f32> = r
            .ids
            .iter()
            .zip(&r.scores[2])
            .filter(|(id, _)| ![base, face].contains(id))
            .map(|(_, s)| *s)
            .collect();
        // 2枚だけで平均0・標準偏差1なら ±1
        assert!(
            others.iter().all(|s| (s.abs() - 1.0).abs() < 1e-5),
            "{others:?}"
        );
    }

    #[test]
    fn 基準画像にポーズがなければ内容と構図だけで比べて理由を返す() {
        let cases = [
            ("none", Some(PoseStatus::None), Skip::NoPerson),
            ("few", Some(PoseStatus::Few), Skip::Few),
            ("uncomputed", None, Skip::Uncomputed),
        ];
        for (name, status, why) in cases {
            let (_d, mut lib) = open();
            let a = pose_aspects();
            let base = match status {
                Some(s) => posed(&mut lib, "base", s, &[]),
                None => image(&mut lib, "base", 0.0),
            };
            posed(&mut lib, "other", PoseStatus::Ok, &[person(&RAISE, &[])]);
            let r = similar(&mut lib, &a, base, &[]).unwrap();
            assert_eq!(r.aspects, ["content", "composition"], "{name}");
            assert_eq!(r.scores.len(), 2, "{name}");
            assert_eq!(r.ids.len(), 2, "{name}");
            assert_eq!(
                r.skipped,
                BTreeMap::from([("pose".to_string(), why)]),
                "{name}"
            );
        }
    }

    #[test]
    fn ポーズのモデルが欠けていれば基準画像にポーズがあっても使わない() {
        let (_d, mut lib) = open();
        let a = pose_aspects();
        let base = posed(&mut lib, "base", PoseStatus::Ok, &[person(&RAISE, &[])]);
        posed(&mut lib, "other", PoseStatus::Ok, &[person(&RAISE, &[])]);
        let r = similar(&mut lib, &a, base, &["pose".into()]).unwrap();
        assert_eq!(r.aspects, ["content", "composition"]);
        assert_eq!(
            r.skipped,
            BTreeMap::from([("pose".to_string(), Skip::MissingModels)])
        );
        assert_eq!(
            serde_json::to_value(&r.skipped).unwrap(),
            serde_json::json!({ "pose": "missing_models" })
        );
    }

    #[test]
    fn 骨格の重ね表示にはポーズのある画像の全員の関節を返す() {
        let (_d, mut lib) = open();
        let a = pose_aspects();
        let two = [person(&RAISE, &[]), person(&lying(&RAISE), &[])];
        let id = posed(&mut lib, "two", PoseStatus::Ok, &two);
        let got = pose_of(&mut lib, &a, id, &[]).unwrap();
        assert_eq!(got.skipped, None);
        assert_eq!(got.people, two.to_vec());
    }

    #[test]
    fn 骨格の重ね表示はポーズのない画像では理由だけを返す() {
        let cases = [
            ("none", Some(PoseStatus::None), &[][..], Skip::NoPerson),
            ("few", Some(PoseStatus::Few), &[][..], Skip::Few),
            ("uncomputed", None, &[][..], Skip::Uncomputed),
            (
                "missing",
                Some(PoseStatus::Ok),
                &["pose".to_string()][..],
                Skip::MissingModels,
            ),
        ];
        for (name, status, missing, why) in cases {
            let (_d, mut lib) = open();
            let a = pose_aspects();
            let id = match status {
                Some(PoseStatus::Ok) => {
                    posed(&mut lib, "x", PoseStatus::Ok, &[person(&RAISE, &[])])
                }
                Some(s) => posed(&mut lib, "x", s, &[]),
                None => image(&mut lib, "x", 0.0),
            };
            let got = pose_of(&mut lib, &a, id, missing).unwrap();
            assert_eq!(got.skipped, Some(why), "{name}");
            assert!(got.people.is_empty(), "{name}");
        }
    }

    #[test]
    fn 骨格の重ね表示はfeatures_dbを作らずに未計算とする() {
        let (dir, mut lib) = open();
        let id = add(&mut lib, "x", "");
        let got = pose_of(&mut lib, &pose_aspects(), id, &[]).unwrap();
        assert_eq!(got.skipped, Some(Skip::Uncomputed));
        assert!(!features::path(dir.path()).exists());
    }

    #[test]
    fn 骨格の重ね表示はポーズの観点がなければモデルがないとする() {
        let (_d, mut lib) = open();
        let id = image(&mut lib, "x", 0.0);
        let got = pose_of(&mut lib, &aspects(), id, &[]).unwrap();
        assert_eq!(got.skipped, Some(Skip::MissingModels));
    }

    #[test]
    fn ポーズの行がなくても内容と構図がそろっていれば結果に出て基準にできる() {
        let (_d, mut lib) = open();
        let base = image(&mut lib, "base", 0.0);
        let near = image(&mut lib, "near", 10.0);
        image(&mut lib, "far", 170.0);
        let a = pose_aspects();

        let r = similar(&mut lib, &a, base, &[]).unwrap();

        assert_eq!(r.ids.len(), 3);
        assert_eq!(r.uncomputed, 0);
        assert!(score(&r, 0, near) > 0.0);
        assert!(ready(&mut lib, &a, base).unwrap());
    }
}
