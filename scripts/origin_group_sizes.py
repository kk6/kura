# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy"]
# ///
"""しきい値ごとに、元が同じ画像の組（FR-611）の大きさの分布を出す。

使い方：uv run scripts/origin_group_sizes.py <ライブラリのフォルダ> [--thresholds 0.97 0.98 0.99] [--ids 2415 5659]

- `src-tauri/src/origin.rs` の group と同じく、しきい値以上の2枚をつないで組にする
- しきい値を変える前に、本物のライブラリで一番大きい組の枚数を確かめるために使う（要件定義書の4章）
- `--ids` の画像が、しきい値ごとに何枚の組に入るかも出す
- ゴミ箱と「見つからない」画像、特徴量のない画像は比べない。DB は読むだけ（mode=ro）で開く
"""

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from measure_same_origin import content_model

DIM = 768
# 2万枚 × 1024 行の float32 で約80MB。これより大きく切ると、メモリを食う
BLOCK = 1024


def connect(kura: Path, name: str) -> sqlite3.Connection:
    f = kura / name
    if not f.exists():
        sys.exit(f"{f} がありません。ライブラリのフォルダを渡してください")
    return sqlite3.connect(f"{f.resolve().as_uri()}?mode=ro", uri=True)


def load(library: Path) -> tuple[list[int], np.ndarray]:
    """比べる画像の id（昇順）と、その内容のベクトル（行ごと）を返す。"""
    kura = library.expanduser() / ".kura"
    images = (
        connect(kura, "kura.db")
        .execute(
            "SELECT id, hash FROM images"
            " WHERE deleted_at IS NULL AND missing_at IS NULL ORDER BY id"
        )
        .fetchall()
    )
    vec = dict(
        connect(kura, "features.db").execute(
            "SELECT hash, vector FROM embeddings WHERE aspect = 'content' AND model = ?",
            (content_model(),),
        )
    )
    rows = [(i, vec[h]) for i, h in images if len(vec.get(h, b"")) == DIM * 4]
    m = np.frombuffer(b"".join(v for _, v in rows), dtype=np.float32)
    return [i for i, _ in rows], m.reshape(len(rows), DIM)


def edges(m: np.ndarray, floor: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """類似度が floor 以上の2枚（a < b）と、その類似度。"""
    ea, eb, es = [], [], []
    for s in range(0, len(m), BLOCK):
        sims = m[s : s + BLOCK] @ m.T
        a, b = np.nonzero(sims >= floor)
        keep = a + s < b
        ea.append(a[keep] + s)
        eb.append(b[keep])
        es.append(sims[a[keep], b[keep]])
    if not ea:
        return np.array([], int), np.array([], int), np.array([], np.float32)
    return np.concatenate(ea), np.concatenate(eb), np.concatenate(es)


def roots(n: int, a: np.ndarray, b: np.ndarray) -> list[int]:
    """2枚ずつつないだ組の代表（組の中で一番小さい番号）を、画像ごとに返す。"""
    parent = list(range(n))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for x, y in zip(a.tolist(), b.tolist()):
        rx, ry = root(x), root(y)
        parent[max(rx, ry)] = min(rx, ry)
    return [root(i) for i in range(n)]


def report(library: Path, thresholds: list[float], wanted: list[int]) -> str:
    ids, m = load(library)
    lines = [f"比べる画像 {len(ids)} 枚（ゴミ箱・見つからない・特徴量なしを除く）"]
    ea, eb, es = edges(m, min(thresholds))
    pos = {id: k for k, id in enumerate(ids)}
    for t in sorted(thresholds):
        sel = es >= t
        r = roots(len(ids), ea[sel], eb[sel])
        size = Counter(r)
        sizes = sorted((c for c in size.values() if c >= 2), reverse=True)
        small = sum(1 for c in sizes if c <= 3)
        mid = sum(1 for c in sizes if 4 <= c <= 10)
        lines += [
            "",
            f"== しきい値 {t}：{int(sel.sum())} 組の2枚、"
            + f"組 {len(sizes)} 個、組に入った画像 {sum(sizes)} 枚",
            f"大きい組の枚数（上位10）：{sizes[:10]}",
            f"2〜3枚の組 {small} 個、4〜10枚 {mid} 個、11枚以上 {len(sizes) - small - mid} 個",
        ]
        for id in wanted:
            if id not in pos:
                lines.append(f"#{id}：比べる画像に入っていない")
            else:
                k = r[pos[id]]
                lines.append(f"#{id}：{size[k]} 枚の組（組の先頭 #{ids[k]}）")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("library", type=Path, help="ライブラリのフォルダ")
    parser.add_argument(
        "--thresholds",
        type=float,
        nargs="+",
        default=[0.90, 0.93, 0.95, 0.97, 0.98, 0.99],
        help="比べるしきい値",
    )
    parser.add_argument(
        "--ids", type=int, nargs="*", default=[], help="所属を見る画像の id"
    )
    args = parser.parse_args()
    print(report(args.library, args.thresholds, args.ids))


if __name__ == "__main__":
    main()
