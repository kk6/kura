# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""ファイル名で指定した画像どうしの、内容（SigLIP 2）のそろえる前のコサイン類似度を出す。

使い方：uv run scripts/pair_similarity.py <ライブラリのフォルダ> <ファイル名1> <ファイル名2> [...]

- 「元が同じ画像の組を探す」（FR-611）で見つからない2枚が、しきい値に届いていないのかを確かめる
- ファイル名は kura.db の file_name で引く（フォルダは要らない）。同じ名前が複数あれば `名前#id` で分けて出す
- 画像ごとに、縦横の大きさ、ファイルサイズ、ゴミ箱か「見つからない」か、特徴量の有無を出す
- DB は読むだけ（mode=ro）で開く。immutable にしないのは、起動中のアプリが WAL に書いた値も読むため
"""

import argparse
import sqlite3
import sys
from array import array
from itertools import combinations
from pathlib import Path

from measure_same_origin import content_model, dot


def connect(kura: Path, name: str) -> sqlite3.Connection:
    f = kura / name
    if not f.exists():
        sys.exit(f"{f} がありません。ライブラリのフォルダを渡してください")
    return sqlite3.connect(f"{f.resolve().as_uri()}?mode=ro", uri=True)


def report(library: Path, names: list[str]) -> str:
    kura = library.expanduser() / ".kura"
    db, feat = connect(kura, "kura.db"), connect(kura, "features.db")
    model = content_model()
    lines, vecs = [], {}
    for name in names:
        rows = db.execute(
            "SELECT id, hash, width, height, file_size, deleted_at, missing_at"
            " FROM images WHERE file_name = ? ORDER BY id",
            (name,),
        ).fetchall()
        if not rows:
            lines.append(f"{name}：kura.db にありません")
        for id, h, w, ht, size, deleted, missing in rows:
            v = feat.execute(
                "SELECT vector FROM embeddings"
                " WHERE hash = ? AND aspect = 'content' AND model = ?",
                (h, model),
            ).fetchone()
            label = f"{name}#{id}"
            state = "、ゴミ箱" if deleted else "、見つからない" if missing else ""
            has = "特徴量なし" if v is None else "特徴量あり"
            lines.append(f"{label}：{w}x{ht}、{size}バイト{state}、{has}")
            if v:
                vecs[label] = array("f", v[0])
    lines += [
        f"{a} × {b}：{dot(vecs[a], vecs[b]):.4f}" for a, b in combinations(vecs, 2)
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("library", type=Path, help="ライブラリのフォルダ")
    parser.add_argument("names", nargs="+", help="画像のファイル名")
    args = parser.parse_args()
    print(report(args.library, args.names))


if __name__ == "__main__":
    main()
