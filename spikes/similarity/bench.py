"""2万件の特徴量を SQLite から読み、基準1枚と全件比較する時間を測る。

使い方: uv run bench.py
乱数のベクトルを使う。本体の実装は Rust なので、ここでの値は目安（タスク6で測り直す）。
"""

import sqlite3
import statistics
import tempfile
import time
from pathlib import Path

import numpy as np

N = 20_000
DIMS = {"content": 768, "composition": 384}  # 内容は候補の最大、構図は gray(256)+edge(128)
RUNS = 7


def main():
    rng = np.random.default_rng(0)
    db_path = Path(tempfile.mkdtemp()) / "features.db"
    db = sqlite3.connect(db_path)
    db.execute("CREATE TABLE features (sha TEXT, kind TEXT, model TEXT, vec BLOB, PRIMARY KEY (sha, kind, model))")
    for kind, dim in DIMS.items():
        v = rng.standard_normal((N, dim), dtype=np.float32)
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        db.executemany("INSERT INTO features VALUES (?, ?, 'm', ?)", ((f"{i:064x}", kind, v[i].tobytes()) for i in range(N)))
    db.commit()
    db.close()
    print(f"features.db: {db_path.stat().st_size / 1e6:.1f} MB（{N}枚 × {DIMS}、float32）")

    read, compare = [], []
    for _ in range(RUNS):
        db = sqlite3.connect(db_path)
        t0 = time.perf_counter()
        mats = {}
        for kind, dim in DIMS.items():
            rows = db.execute("SELECT vec FROM features WHERE kind = ? ORDER BY sha", (kind,)).fetchall()
            mats[kind] = np.frombuffer(b"".join(r[0] for r in rows), dtype=np.float32).reshape(-1, dim)
        t1 = time.perf_counter()
        scores = {kind: m @ m[0] for kind, m in mats.items()}
        order = np.argsort(-(scores["content"] + scores["composition"]))
        t2 = time.perf_counter()
        db.close()
        assert all(m.shape[0] == N for m in mats.values()) and order[0] == 0 and len(order) == N
        read.append((t1 - t0) * 1000)
        compare.append((t2 - t1) * 1000)

    for label, xs in (("SQLite から読む", read), ("全件比較と並べ替え", compare)):
        print(f"{label}: 中央値 {statistics.median(xs):.1f} ms（{min(xs):.1f}〜{max(xs):.1f}、{RUNS}回）")


if __name__ == "__main__":
    main()
