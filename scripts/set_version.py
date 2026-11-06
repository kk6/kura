"""アプリのバージョンを、バージョンを持つファイルすべてで書き換える。

使い方: npm run version:set -- 0.2.0
食い違いは npm run lint（scripts/check-docs.mjs）が見つける。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ファイルと、バージョンの直前までに当たる正規表現。JSON を読み直して書くと整形が変わるので、文字列で置き換える
TARGETS = [
    ("package.json", r'^(  "version": ")[^"]+'),
    ("package-lock.json", r'^(  "version": ")[^"]+'),
    (
        "package-lock.json",
        r'(\n    "": \{\n      "name": "kura",\n      "version": ")[^"]+',
    ),
    ("src-tauri/tauri.conf.json", r'^(  "version": ")[^"]+'),
    ("src-tauri/Cargo.toml", r'^(\[package\]\nname = "kura"\nversion = ")[^"]+'),
    ("src-tauri/Cargo.lock", r'^(name = "kura"\nversion = ")[^"]+'),
]

VERSION = re.compile(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?")


def set_version(root: Path, version: str) -> None:
    if not VERSION.fullmatch(version):
        raise ValueError(f"バージョンの形が正しくない: {version}（例: 0.2.0）")
    # 全部の置き換えを確かめてから書く。途中で止まって一部だけ変わるのを避ける
    texts: dict[str, str] = {}
    for name, pattern in TARGETS:
        text = texts.get(name) or (root / name).read_text(encoding="utf-8")
        text, n = re.subn(
            pattern, rf"\g<1>{version}", text, count=1, flags=re.MULTILINE
        )
        if n != 1:
            raise ValueError(f"{name} にバージョンが見つからない")
        texts[name] = text
    for name, text in texts.items():
        (root / name).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("使い方: npm run version:set -- <バージョン>")
    try:
        set_version(ROOT, sys.argv[1])
    except ValueError as e:
        sys.exit(str(e))
    print(f"バージョンを {sys.argv[1]} にした")
