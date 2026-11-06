import shutil
from pathlib import Path

import pytest
from set_version import ROOT, TARGETS, set_version

FILES = sorted({name for name, _ in TARGETS})


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    for name in FILES:
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / name, tmp_path / name)
    return tmp_path


def test_set_version_changes_only_the_app_version_lines(repo: Path) -> None:
    before = {name: (repo / name).read_text() for name in FILES}
    set_version(repo, "12.34.56")
    for name in FILES:
        old, new = before[name].splitlines(), (repo / name).read_text().splitlines()
        changed = [(a, b) for a, b in zip(old, new, strict=True) if a != b]
        expected = 2 if name == "package-lock.json" else 1
        assert len(changed) == expected, name
        assert all("12.34.56" in b for _, b in changed), name


def test_set_version_rejects_bad_version_without_writing(repo: Path) -> None:
    before = {name: (repo / name).read_text() for name in FILES}
    with pytest.raises(ValueError):
        set_version(repo, "v0.2")
    assert {name: (repo / name).read_text() for name in FILES} == before
