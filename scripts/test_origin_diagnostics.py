import math
import sqlite3
from array import array
from pathlib import Path

import pytest
from measure_same_origin import content_model
from origin_group_sizes import report as group_report
from pair_similarity import report as pair_report


def unit(deg: float) -> bytes:
    """768次元のうち先頭2つだけを使う、長さ1のベクトル。角度で向きを決める。"""
    r = math.radians(deg)
    return array("f", [math.cos(r), math.sin(r)] + [0.0] * 766).tobytes()


def library(tmp_path: Path, images: list[tuple[str, str, float | None]]) -> Path:
    """(ファイル名, 状態, 角度) の画像を入れた kura.db と features.db を作る。状態は "" か "trash" か "missing"。"""
    kura = tmp_path / ".kura"
    kura.mkdir()
    db = sqlite3.connect(kura / "kura.db")
    db.execute(
        "CREATE TABLE images(id INTEGER PRIMARY KEY, file_name TEXT, hash TEXT,"
        " width INTEGER, height INTEGER, file_size INTEGER,"
        " deleted_at INTEGER, missing_at INTEGER)"
    )
    feat = sqlite3.connect(kura / "features.db")
    feat.execute(
        "CREATE TABLE embeddings(hash TEXT, aspect TEXT, model TEXT, vector BLOB,"
        " computed_at INTEGER)"
    )
    for k, (name, state, deg) in enumerate(images):
        db.execute(
            "INSERT INTO images VALUES (?, ?, ?, 10, 20, 300, ?, ?)",
            (
                k + 1,
                name,
                f"h{k}",
                state == "trash" or None,
                state == "missing" or None,
            ),
        )
        if deg is not None:
            feat.execute(
                "INSERT INTO embeddings VALUES (?, 'content', ?, ?, 0)",
                (f"h{k}", content_model(), unit(deg)),
            )
    for con in (db, feat):
        con.commit()
        con.close()
    return tmp_path


def test_pair_similarity_prints_cosine_and_each_image_state(tmp_path: Path) -> None:
    lib = library(
        tmp_path,
        [("a.jpg", "", 0.0), ("b.jpg", "trash", 60.0), ("c.jpg", "", None)],
    )
    out = pair_report(lib, ["a.jpg", "b.jpg", "c.jpg", "none.jpg"])
    assert "a.jpg#1：10x20、300バイト、特徴量あり" in out
    assert "b.jpg#2：10x20、300バイト、ゴミ箱、特徴量あり" in out
    assert "c.jpg#3：10x20、300バイト、特徴量なし" in out
    assert "none.jpg：kura.db にありません" in out
    assert "a.jpg#1 × b.jpg#2：0.5000" in out
    assert "c.jpg#3 ×" not in out


def test_pair_similarity_splits_images_with_the_same_name(tmp_path: Path) -> None:
    lib = library(tmp_path, [("a.jpg", "", 0.0), ("a.jpg", "", 0.0)])
    assert "a.jpg#1 × a.jpg#2：1.0000" in pair_report(lib, ["a.jpg"])


def test_group_sizes_chain_pairs_and_shrink_as_threshold_rises(tmp_path: Path) -> None:
    # 1–2、2–3 は10°差（0.985）、1–3 は20°差（0.940）。4–5 は5°差（0.996）
    lib = library(
        tmp_path,
        [
            ("1.jpg", "", 0.0),
            ("2.jpg", "", 10.0),
            ("3.jpg", "", 20.0),
            ("4.jpg", "", 100.0),
            ("5.jpg", "", 105.0),
            ("6.jpg", "", 200.0),
            ("trash.jpg", "trash", 0.0),
            ("none.jpg", "", None),
        ],
    )
    out = group_report(lib, [0.99, 0.98, 0.93], [1, 3, 7])
    assert out.startswith("比べる画像 6 枚")
    # しきい値は小さい順に出す
    low, mid, high = out.split("\n\n")[1:]
    assert "しきい値 0.93：4 組の2枚、組 2 個、組に入った画像 5 枚" in low
    assert "大きい組の枚数（上位10）：[3, 2]" in low
    assert "#3：3 枚の組（組の先頭 #1）" in low
    # 0.98 では 1–3 がつながらないが、2 を通して1つの組のまま
    assert "しきい値 0.98：3 組の2枚、組 2 個" in mid
    assert "#3：3 枚の組（組の先頭 #1）" in mid
    assert "しきい値 0.99：1 組の2枚、組 1 個、組に入った画像 2 枚" in high
    assert "#1：1 枚の組（組の先頭 #1）" in high
    assert "#7：比べる画像に入っていない" in high


def test_scripts_stop_without_a_library(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="kura.db がありません"):
        pair_report(tmp_path, ["a.jpg"])
    with pytest.raises(SystemExit, match="kura.db がありません"):
        group_report(tmp_path, [0.98], [])
