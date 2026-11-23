from pathlib import Path

import pytest
from gen_same_origin import VARIANTS, generate
from PIL import Image, ImageDraw


def photo(path: Path, size: tuple[int, int] = (400, 300)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.new("RGB", size, (200, 120, 40))
    ImageDraw.Draw(im).rectangle((0, 0, size[0] // 4, size[1] // 4), fill=(0, 0, 255))
    im.save(path)


def test_generate_writes_original_and_every_variant_per_photo(tmp_path: Path) -> None:
    photo(tmp_path / "src" / "a.jpg")
    photo(tmp_path / "src" / "人物" / "b.png")
    (tmp_path / "src" / "メモ.txt").write_text("x")
    photo(tmp_path / "src" / ".kura" / "thumbs" / "c.jpg")

    assert generate(tmp_path / "src", tmp_path / "out") == 2
    for d, ext in [("0000", ".jpg"), ("0001", ".png")]:
        names = {p.name for p in (tmp_path / "out" / d).iterdir()}
        assert names == {f"original{ext}"} | {f"{v}.jpg" for v in VARIANTS}


def test_generate_keeps_original_bytes_and_source_untouched(tmp_path: Path) -> None:
    photo(tmp_path / "src" / "a.jpg")
    before = (tmp_path / "src" / "a.jpg").read_bytes()
    generate(tmp_path / "src", tmp_path / "out")
    assert (tmp_path / "out" / "0000" / "original.jpg").read_bytes() == before
    assert (tmp_path / "src" / "a.jpg").read_bytes() == before


@pytest.mark.parametrize(
    ("name", "size"),
    [
        ("scale50", (200, 150)),
        ("scale25", (100, 75)),
        ("crop90", (360, 270)),
        ("crop75", (300, 225)),
        ("brightness120", (400, 300)),
    ],
)
def test_generate_variant_sizes(tmp_path: Path, name: str, size: tuple) -> None:
    photo(tmp_path / "src" / "a.jpg")
    generate(tmp_path / "src", tmp_path / "out")
    with Image.open(tmp_path / "out" / "0000" / f"{name}.jpg") as im:
        assert im.size == size


def test_generate_does_not_mirror(tmp_path: Path) -> None:
    # 左上の青い四角が、反転していれば右上に移る
    photo(tmp_path / "src" / "a.png")
    generate(tmp_path / "src", tmp_path / "out")
    with Image.open(tmp_path / "out" / "0000" / "saturation140.jpg") as im:
        left, right = im.getpixel((10, 10)), im.getpixel((im.width - 10, 10))
    assert left[2] > left[0] and right[0] > right[2]


def test_generate_exits_when_output_not_empty(tmp_path: Path) -> None:
    photo(tmp_path / "src" / "a.jpg")
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "keep.txt").write_text("x")
    with pytest.raises(SystemExit):
        generate(tmp_path / "src", tmp_path / "out")
    assert (tmp_path / "out" / "keep.txt").read_text() == "x"
