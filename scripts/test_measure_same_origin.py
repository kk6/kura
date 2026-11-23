import hashlib
import math
import sqlite3
from array import array
from pathlib import Path

import pytest
from measure_same_origin import content_model, report, vectors


def unit(*xs: float) -> array:
    n = math.hypot(*xs)
    return array("f", [x / n for x in xs])


def library(tmp_path: Path, files: dict[str, array | None]) -> tuple[Path, Path]:
    """pairs/<番号>/<名前> にファイルを置き、その SHA-256 でベクトルを入れた features.db を作る。"""
    pairs, db = tmp_path / "pairs", tmp_path / "features.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE embeddings(hash TEXT, aspect TEXT, model TEXT, vector BLOB,"
        " computed_at INTEGER)"
    )
    for rel, vec in files.items():
        f = pairs / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(rel.encode())
        if vec is not None:
            h = hashlib.sha256(f.read_bytes()).hexdigest()
            con.execute(
                "INSERT INTO embeddings VALUES (?, 'content', ?, ?, 0)",
                (h, content_model(), vec.tobytes()),
            )
    con.commit()
    con.close()
    return pairs, db


def test_report_separates_variants_from_other_photos(tmp_path: Path) -> None:
    pairs, db = library(
        tmp_path,
        {
            "0000/original.jpg": unit(1, 0, 0),
            "0000/crop90.jpg": unit(1, 0.1, 0),
            "0001/original.jpg": unit(0, 1, 0),
            "0001/crop90.jpg": unit(0.5, 1, 0),
            "0002/original.jpg": unit(0, 0, 1),
            "0002/crop90.jpg": unit(0, 0, 1),
            # 0000 と中身が同じ写真。別の写真どうしに数えない
            "0003/original.jpg": unit(1, 0, 0),
            "0003/crop90.jpg": unit(1, 0, 0),
        },
    )
    out = report(vectors(pairs, db))
    crop = next(line for line in out.splitlines() if line.startswith("| crop90 "))
    assert crop.split(" | ")[1:3] == ["4", f"{1 / math.hypot(0.5, 1):.3f}"]
    other = next(line for line in out.splitlines() if "別の写真どうし |" in line)
    # 元どうしは直交するので、同じ写真の組を除いた5組とも0
    assert other.split(" | ")[1:3] == ["5", "0.000"]
    assert other.rstrip(" |").endswith("0.000")


def test_vectors_exits_when_a_file_has_no_feature(tmp_path: Path) -> None:
    pairs, db = library(
        tmp_path, {"0000/original.jpg": unit(1, 0), "0000/scale50.jpg": None}
    )
    with pytest.raises(SystemExit, match="1 件"):
        vectors(pairs, db)
