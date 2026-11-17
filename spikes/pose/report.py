"""out/poses.json から、並びを見比べる out/index.html と、統計の out/stats.md を作る。

使い方: uv run report.py
"""

import json
from itertools import product
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
OUT = HERE / "out"
MODELS = ["rtmpose-s", "rtmpose-m", "rtmo-s"]
KINDS = ["thumb", "orig"]
KPT_THR = 0.3  # これ未満の関節は「見えない」として比べない
MIN_JOINTS = 6  # 比べられる関節がこれ未満なら、ポーズを比べない
TOP = 10
# COCO 17点の左右の組（目、耳、肩、肘、手首、股関節、膝、足首）
FLIP = np.array([0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15])


def people(entry, size):
    """関節が MIN_JOINTS 以上見えている人物を、(座標[17,2] ピクセル, 見えているか[17], 枠の面積) で返す。"""
    out = []
    for box, k, s in zip(entry["boxes"], entry["kpts"], entry["scores"]):
        valid = np.array(s) >= KPT_THR
        if valid.sum() >= MIN_JOINTS:
            area = (box[2] - box[0]) * (box[3] - box[1])
            out.append((np.array(k) * size, valid, area))
    return out


def status(entry, size):
    if not entry["boxes"]:
        return "none"  # 人物なし
    return "ok" if people(entry, size) else "few"  # 人物はいるが、比べられる関節が足りない


def sims_to_all(ka, va, K, V):
    """1人（ka[17,2], va[17]）と全員（K[P,17,2], V[P,17]）のポーズの近さ。
    共通に見えている関節だけで位置と大きさをそろえたコサイン類似度に、
    基準の見えている関節のうち比べられた割合を掛ける（共通の関節が少ない組が不当に高くならないように）。"""
    shared = va & V
    cnt = shared.sum(1)
    w = shared[..., None]
    c = np.maximum(cnt, 1)[:, None, None]
    x = (ka - (ka * w).sum(1, keepdims=True) / c) * w
    y = (K - (K * w).sum(1, keepdims=True) / c) * w
    s = (x * y).sum((1, 2)) / (np.linalg.norm(x, axis=(1, 2)) * np.linalg.norm(y, axis=(1, 2)) + 1e-9)
    s = s * cnt / va.sum()
    return np.where(cnt >= MIN_JOINTS, s, np.nan)


def matrix(entries, sizes, multi, mirror):
    ps = [people(e, s) for e, s in zip(entries, sizes)]
    if multi == "largest":
        ps = [sorted(p, key=lambda x: -x[2])[:1] for p in ps]
    n = len(ps)
    m = np.full((n, n), np.nan)
    flat = [(i, k, v) for i, p in enumerate(ps) for k, v, _ in p]
    if not flat:
        return m
    owner = np.array([f[0] for f in flat])
    K, V = np.stack([f[1] for f in flat]), np.stack([f[2] for f in flat])
    Kf, Vf = K[:, FLIP] * [-1, 1], V[:, FLIP]  # 左右反転した骨格
    for i, p in enumerate(ps):
        for ka, va, _ in p:
            s = sims_to_all(ka, va, K, V)
            if mirror:
                s = np.fmax(s, sims_to_all(ka, va, Kf, Vf))
            for j in np.unique(owner):  # 複数人の画像は一番近い人物を使う
                vals = s[owner == j]
                if j != i and np.isfinite(vals).any():
                    m[i, j] = np.fmax(m[i, j], np.nanmax(vals))
    return m


def top(m, i, k=TOP):
    row = np.where(np.isnan(m[i]), -np.inf, m[i])
    return [j for j in np.argsort(-row) if np.isfinite(row[j])][:k]


def overlap(a, b, i):
    ta, tb = top(a, i), top(b, i)
    return len(set(ta) & set(tb)) / max(len(ta), 1)


def self_test():
    rng = np.random.default_rng(0)
    k, v = rng.random((17, 2)) * 100, np.ones(17, bool)
    moved = k * 3 + [50, -20]  # 位置と大きさだけ違う
    mirrored = (k * [-1, 1])[FLIP]
    v_few = v.copy()
    v_few[MIN_JOINTS - 1 :] = False
    s = sims_to_all(k, v, np.stack([moved, mirrored, k]), np.stack([v, v, v_few]))
    assert abs(s[0] - 1) < 1e-6, s
    assert s[1] < 0.99, s  # 反転は区別される
    assert abs(sims_to_all(k, v, mirrored[None][:, FLIP] * [-1, 1], v[None])[0] - 1) < 1e-6  # 戻せば一致
    assert np.isnan(s[2]), s  # 共通の関節が6点未満


def main():
    self_test()
    data =json.loads((OUT / "poses.json").read_text())
    timings = json.loads((OUT / "timings.json").read_text())
    names, sizes, poses = data["names"], np.array(data["sizes"], dtype=float), data["poses"]
    n = len(names)
    lines = [f"画像 {n}枚。関節の閾値 {KPT_THR}、比べるのに要る関節 {MIN_JOINTS}点以上。", ""]

    lines += ["## 時間（1スレッド、1枚あたり。最初の3枚を除く）", "",
              "| 構成 | 画像 | 読み込み | 検出 | 骨格 | 全体（中央 / 平均 / p95） | 人数別の骨格（0 / 1 / 2 / 3人以上） | 4000万画素超 | セッションの読み込み | 2万枚の見込み |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for key, t in timings.items():
        by = t["pose_ms_median_by_people"]
        lines.append(
            f"| {key.split('|')[0]} | {key.split('|')[1]} | {t['read_ms_median']}ms | {t['det_ms_median']}ms | {t['pose_ms_median']}ms"
            f" | {t['total_ms_median']} / {t['total_ms_mean']} / {t['total_ms_p95']}ms"
            f" | {' / '.join(by.get(str(k), '-').__str__() for k in range(4))}"
            f" | {t['big_images_total_ms_median'] or '-'}ms | {t['session_load_ms']}ms"
            f" | 約{20000 * t['total_ms_mean'] / 60000:.0f}分 |")

    lines += ["", "## 検出の結果（枚数）", "",
              "| 構成 | 画像 | 人物なし | 比べられる関節が足りない | ポーズあり | 2人以上 |", "| --- | --- | --- | --- | --- | --- |"]
    statuses = {}
    for model, kind in product(MODELS, KINDS):
        e = poses[f"{model}|{kind}"]
        st = [status(x, s) for x, s in zip(e, sizes)]
        statuses[f"{model}|{kind}"] = st
        multi = sum(len(people(x, s)) >= 2 for x, s in zip(e, sizes))
        lines.append(f"| {model} | {kind} | {st.count('none')} | {st.count('few')} | {st.count('ok')} | {multi} |")

    mats = {}
    for model, kind, multi, mirror in product(MODELS, KINDS, ["largest", "all"], [False, True]):
        key = f"{model}|{kind}|{multi}|{'mirror' if mirror else 'plain'}"
        mats[key] = matrix(poses[f"{model}|{kind}"], sizes, multi, mirror)
        print(key, flush=True)

    def mean_overlap(a, b):
        rows = [i for i in range(n) if top(mats[a], i) and top(mats[b], i)]
        return f"{np.mean([overlap(mats[a], mats[b], i) for i in rows]):.0%}（{len(rows)}枚）"

    lines += ["", "## サムネイルと元の画像の上位10件の重なり（一番大きい1人、反転を区別する）", "",
              "| 構成 | 重なり（両方でポーズのある基準画像） |", "| --- | --- |"]
    for model in MODELS:
        lines.append(f"| {model} | {mean_overlap(f'{model}|thumb|largest|plain', f'{model}|orig|largest|plain')} |")

    lines += ["", "## 構成どうしの上位10件の重なり（サムネイル、一番大きい1人、反転を区別する）", "",
              "| | " + " | ".join(MODELS) + " |", "| --- |" + " --- |" * len(MODELS)]
    for a in MODELS:
        lines.append(f"| {a} | " + " | ".join(
            mean_overlap(f"{a}|thumb|largest|plain", f"{b}|thumb|largest|plain") for b in MODELS) + " |")

    lines += ["", "## 扱い方を変えたときの上位10件の重なり（rtmpose-m、サムネイル）", "", "| 比べたもの | 重なり |", "| --- | --- |",
              f"| 一番大きい1人 と 全員の一番近い組 | {mean_overlap('rtmpose-m|thumb|largest|plain', 'rtmpose-m|thumb|all|plain')} |",
              f"| 反転を区別する と 同じとみなす | {mean_overlap('rtmpose-m|thumb|largest|plain', 'rtmpose-m|thumb|largest|mirror')} |"]

    (OUT / "stats.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))

    page = dict(
        names=names, sizes=sizes.astype(int).tolist(), statuses=statuses, kptThr=KPT_THR,
        poses=poses,
        sims={k: [[None if np.isnan(v) else round(float(v), 3) for v in row] for row in m] for k, m in mats.items()},
    )
    html = (HERE / "template.html").read_text().replace("/*DATA*/", json.dumps(page, ensure_ascii=False))
    (OUT / "index.html").write_text(html)


if __name__ == "__main__":
    main()
