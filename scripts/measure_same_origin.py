# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""gen_same_origin.py で作った写しの、内容（SigLIP 2）のそろえる前のコサイン類似度の分布を出す。

使い方：uv run scripts/measure_same_origin.py <gen_same_origin.py の出力先> <features.db>

- 類似度はアプリが計算した値で測る。出力先をライブラリに置いて実アプリで特徴量を計算させ、その .kura/features.db を渡す
  （サムネイルの作り方の小さな差でも値が 0.9 前後まで下がるので、Pillow で真似たサムネイルは使わない）
- ファイルの SHA-256 で features.db の内容のベクトルを引く。DB は読むだけ（immutable）で開く
- 変形の種類ごとの元の写真との類似度と、別の写真の元どうしの類似度の分布を Markdown で出す
"""

import argparse
import hashlib
import json
import sqlite3
import statistics
import sys
from array import array
from itertools import combinations
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent.parent / "ml" / "model.json"


def content_model() -> str:
    aspects = json.loads(MANIFEST.read_text(encoding="utf-8"))["aspects"]
    return next(a["model"] for a in aspects if a["aspect"] == "content")


def vectors(pairs: Path, db: Path) -> dict[str, dict[str, array]]:
    """{写真の番号: {original か変形の名前: ベクトル}} を返す。"""
    con = sqlite3.connect(f"{db.resolve().as_uri()}?immutable=1", uri=True)
    model = content_model()
    out: dict[str, dict[str, array]] = {}
    missing = []
    for f in sorted(pairs.glob("*/*")):
        h = hashlib.sha256(f.read_bytes()).hexdigest()
        row = con.execute(
            "SELECT vector FROM embeddings"
            " WHERE hash = ? AND aspect = 'content' AND model = ?",
            (h, model),
        ).fetchone()
        if row is None:
            missing.append(f)
            continue
        out.setdefault(f.parent.name, {})[f.stem] = array("f", row[0])
    if missing:
        sys.exit(
            f"features.db に内容の特徴量がないファイルが {len(missing)} 件あります"
            f"（例：{missing[0]}）"
        )
    return out


def dot(a: array, b: array) -> float:
    # ベクトルは長さ1で保存しているので、内積がコサイン類似度になる
    return sum(x * y for x, y in zip(a, b))


def stats(v: list[float]) -> dict[str, float]:
    q = statistics.quantiles(v, n=1000, method="inclusive")
    return {
        "n": len(v),
        "min": min(v),
        "p1": q[9],
        "p5": q[49],
        "median": statistics.median(v),
        "p99": q[989],
        "p99.9": q[998],
        "max": max(v),
    }


def report(vecs: dict[str, dict[str, array]]) -> str:
    same: dict[str, list[tuple[float, str]]] = {}
    for g, v in vecs.items():
        for name, x in v.items():
            if name != "original":
                same.setdefault(name, []).append((dot(v["original"], x), g))
    # 見本の写真に中身が同じファイルがあると、ベクトルも同じになる。同じ写真なので別の写真どうしに数えない
    other = [
        (dot(vecs[a]["original"], vecs[b]["original"]), a, b)
        for a, b in combinations(sorted(vecs), 2)
        if vecs[a]["original"] != vecs[b]["original"]
    ]
    rows = {name: stats([s for s, _ in v]) for name, v in same.items()}
    rows["変形すべて"] = stats([s for v in same.values() for s, _ in v])
    rows["別の写真どうし"] = stats([s for s, _, _ in other])

    cols = ["n", "min", "p1", "p5", "median", "p99", "p99.9", "max"]
    lines = ["| 種類 | " + " | ".join(cols) + " |", "|---" * (len(cols) + 1) + "|"]
    for name, s in rows.items():
        cells = [str(s["n"])] + [f"{s[c]:.3f}" for c in cols[1:]]
        lines.append(f"| {name} | " + " | ".join(cells) + " |")
    lines += ["", "別の写真どうしの上位10組："]
    lines += [f"- {s:.3f} {a} {b}" for s, a, b in sorted(other, reverse=True)[:10]]
    lines += ["", "変形の下位10件："]
    worst = sorted((s, g, n) for n, v in same.items() for s, g in v)[:10]
    lines += [f"- {s:.3f} {g} {n}" for s, g, n in worst]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("pairs", type=Path, help="gen_same_origin.py の出力先")
    parser.add_argument("db", type=Path, help="特徴量を計算した features.db")
    args = parser.parse_args()
    print(report(vectors(args.pairs, args.db)))


if __name__ == "__main__":
    main()
