from collections import Counter
from pathlib import Path

import pytest
from gen_dev_library import EMPTY_FOLDER, generate
from PIL import Image

IMAGE_EXTS = {".jpg", ".png", ".webp", ".gif"}


def images(root: Path) -> list[Path]:
    return [
        p
        for p in root.rglob("*")
        if p.suffix in IMAGE_EXTS and not p.name.startswith(".")
    ]


def test_generate_writes_requested_count_outside_duplicates(tmp_path: Path) -> None:
    generate(40, tmp_path)
    assert len([p for p in images(tmp_path) if p.parent.name != "_重複"]) == 40


def test_generate_writes_format_matching_extension(tmp_path: Path) -> None:
    generate(40, tmp_path)
    expected = {".jpg": "JPEG", ".png": "PNG", ".webp": "WEBP", ".gif": "GIF"}
    for path in images(tmp_path):
        with Image.open(path) as im:
            assert im.format == expected[path.suffix], path


def test_generate_includes_import_edge_cases(tmp_path: Path) -> None:
    generate(40, tmp_path)
    contents = Counter(p.read_bytes() for p in images(tmp_path))
    assert any(n > 1 for n in contents.values()), "中身が同じ画像がある"
    assert (tmp_path / EMPTY_FOLDER).is_dir() and not any(
        (tmp_path / EMPTY_FOLDER).iterdir()
    )
    assert list(tmp_path.rglob(".*.jpg")), "隠しファイルがある"
    assert list(tmp_path.rglob("*.heic")), "対応していない形式がある"


def test_generate_is_deterministic_for_same_count(tmp_path: Path) -> None:
    generate(10, tmp_path / "a")
    generate(10, tmp_path / "b")
    a = {p.relative_to(tmp_path / "a"): p.read_bytes() for p in images(tmp_path / "a")}
    b = {p.relative_to(tmp_path / "b"): p.read_bytes() for p in images(tmp_path / "b")}
    assert a == b


def test_generate_exits_when_output_not_empty(tmp_path: Path) -> None:
    (tmp_path / "keep.txt").write_text("x")
    with pytest.raises(SystemExit):
        generate(1, tmp_path)
    assert (tmp_path / "keep.txt").read_text() == "x"
