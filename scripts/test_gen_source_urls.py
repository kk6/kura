import plistlib
import subprocess
import sys
from pathlib import Path

import pytest
from gen_source_urls import ATTR, BASE, SETS, generate, records


def test_records_cover_the_cases_in_the_check_list() -> None:
    recs = records("import")
    lists = {
        name: plistlib.loads(data)
        for name, data in recs.items()
        if data is not None and name != "garbage"
    }
    img, page = f"{BASE}/img/import-two.png", f"{BASE}/page/import-two"
    assert lists["two"] == [img, page]
    assert len(lists["one"]) == 1
    assert recs["none"] is None
    assert len(lists["three"]) == 3
    assert all(not u.startswith("http") for u in lists["non-http"])
    assert lists["page-only"][1].startswith("http")
    assert not lists["page-only"][0].startswith("http")
    assert lists["image-only"][0].startswith("http")
    assert not lists["image-only"][1].startswith("http")
    assert all(not u.startswith("http") for u in lists["invalid"])
    assert recs["xml"].startswith(b"<?xml")
    assert recs["two"].startswith(b"bplist")
    with pytest.raises(plistlib.InvalidFileException):
        plistlib.loads(recs["garbage"])


def test_records_differ_between_sets() -> None:
    assert records("import")["two"] != records("finder")["two"]


@pytest.mark.skipif(sys.platform != "darwin", reason="拡張属性は macOS の xattr で書く")
def test_generate_writes_distinct_images_with_where_froms(tmp_path: Path) -> None:
    generate(tmp_path)
    files = sorted(tmp_path.rglob("*.png"))
    assert {p.parent.name for p in files} == set(SETS)
    # 重複用の1枚だけが、ほかの画像と同じ中身
    assert len({p.read_bytes() for p in files}) == len(files) - 1

    dup = tmp_path / "import-dup" / "two-again.png"
    assert dup.read_bytes() == (tmp_path / "import" / "two.png").read_bytes()

    def read(p: Path) -> bytes | None:
        r = subprocess.run(
            ["/usr/bin/xattr", "-px", ATTR, p],
            check=False,
            capture_output=True,
            text=True,
        )
        return bytes.fromhex(r.stdout.replace("\n", "")) if r.returncode == 0 else None

    assert read(tmp_path / "finder" / "two.png") == records("finder")["two"]
    assert read(tmp_path / "backfill" / "none.png") is None
    assert plistlib.loads(read(dup)) != plistlib.loads(
        read(tmp_path / "import" / "two.png")
    )


def test_generate_refuses_a_non_empty_folder(tmp_path: Path) -> None:
    (tmp_path / "x").write_text("x")
    with pytest.raises(SystemExit):
        generate(tmp_path)
