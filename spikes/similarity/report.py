"""out/feats.npz から、並びを見比べる out/index.html と、統計の out/stats.md を作る。

使い方: uv run report.py
"""

import json
from pathlib import Path

import numpy as np

OUT = Path(__file__).parent / "out"
CONTENT = ["clip-b32", "siglip2-b16", "dinov2-s", "dinov2-b"]
COMP = ["gray", "edge", "gray+edge"]
TOP = 10


def sims(feats, key, kind):
    if key == "gray+edge":  # 2つの類似度の平均
        return (sims(feats, "gray", kind) + sims(feats, "edge", kind)) / 2
    v = feats[f"{key}|{kind}"]
    return v @ v.T


def top(s, i, k=TOP):
    order = np.argsort(-s[i])
    return [j for j in order if j != i][:k]


def off_diagonal(s):
    return s[~np.eye(len(s), dtype=bool)]


def main():
    feats = np.load(OUT / "feats.npz")
    names = json.loads((OUT / "names.json").read_text())
    cats = np.array([n.split("/")[0] for n in names])
    n = len(names)
    lines = [f"画像 {n}枚。カテゴリ: " + "、".join(f"{c} {int((cats == c).sum())}" for c in sorted(set(cats))), ""]

    lines += ["## 類似度の幅（サムネイルから計算。自分自身を除く全組）", "",
              "| 観点 | 5% | 50% | 95% | 最大 | 同じカテゴリが上位10件に占める割合 |", "| --- | --- | --- | --- | --- | --- |"]
    matrices = {}
    for key in CONTENT + COMP:
        s = sims(feats, key, "thumb")
        matrices[key] = s
        p = np.percentile(off_diagonal(s), [5, 50, 95, 100])
        same = np.mean([np.mean(cats[top(s, i)] == cats[i]) for i in range(n)])
        lines.append(f"| {key} | {p[0]:.2f} | {p[1]:.2f} | {p[2]:.2f} | {p[3]:.2f} | {same:.0%} |")

    lines += ["", "## サムネイルと元の画像の差", "",
              "| 観点 | 同じ画像の2つのベクトルの類似度（最小 / 中央） | 上位10件の重なり（平均） | 上位10件が1件も変わらない画像 |",
              "| --- | --- | --- | --- |"]
    for key in CONTENT + COMP:
        st, so = matrices[key], sims(feats, key, "orig")
        if key == "gray+edge":
            self_sim = None
        else:
            self_sim = np.sum(feats[f"{key}|thumb"] * feats[f"{key}|orig"], axis=1)
        overlap = [len(set(top(st, i)) & set(top(so, i))) / TOP for i in range(n)]
        same_all = sum(o == 1 for o in overlap)
        self_txt = "-" if self_sim is None else f"{self_sim.min():.3f} / {np.median(self_sim):.3f}"
        lines.append(f"| {key} | {self_txt} | {np.mean(overlap):.0%} | {same_all} / {n} |")

    lines += ["", "## モデルどうしの上位10件の重なり（サムネイル）", "",
              "| | " + " | ".join(CONTENT) + " |", "| --- |" + " --- |" * len(CONTENT)]
    for a in CONTENT:
        row = [f"{np.mean([len(set(top(matrices[a], i)) & set(top(matrices[b], i))) / TOP for i in range(n)]):.0%}"
               for b in CONTENT]
        lines.append(f"| {a} | " + " | ".join(row) + " |")

    (OUT / "stats.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))

    data = dict(
        names=names,
        content={k: np.round(matrices[k], 3).tolist() for k in CONTENT},
        comp={k: np.round(matrices[k], 3).tolist() for k in COMP},
    )
    html = (Path(__file__).parent / "template.html").read_text().replace("/*DATA*/", json.dumps(data, ensure_ascii=False))
    (OUT / "index.html").write_text(html)


if __name__ == "__main__":
    main()
