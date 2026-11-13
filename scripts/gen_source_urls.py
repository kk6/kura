# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow"]
# ///
"""元URL（ダウンロード元の記録）の確認用に、拡張属性を付けたダミー画像を作る。macOS 専用。

使い方：uv run scripts/gen_source_urls.py <出力先>   （出力先は空のフォルダか、まだないフォルダ）

ブラウザでダウンロードしたときに macOS が付ける com.apple.metadata:kMDItemWhereFroms を、
画像ごとに決まった中身で付ける。URL はすべて http://127.0.0.1:8765 の下で、外へ通信しない。
出力先の下に次のフォルダを作る。中身の画素は画像ごとに違うので、互いに重複しない。

- import/      通常の取り込み用。下の各ケースを1枚ずつ
- import-dup/  import/ を取り込んだ後に取り込む。two-again.png は import/two.png と同じ中身で、別の記録を持つ
- finder/      Finder でライブラリのフォルダに置き、差分の確認で登録する用
- backfill/    元URLを保存しない旧版で取り込み、「元URLを補完」で読み直す用

ケース：two（画像URLと掲載ページURL）、one（画像URLだけ）、none（記録なし）、three（3件）、
xml（XML 形式の plist）、empty-second（2件目が空）、page-only（1件目が http でない）、
image-only（2件目が http でない）、non-http（どちらも http でない）、invalid（URL でない文字列）、
garbage（plist でない）
"""

import argparse
import plistlib
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ATTR = "com.apple.metadata:kMDItemWhereFroms"
BASE = "http://127.0.0.1:8765"
SETS = ["import", "import-dup", "finder", "backfill"]
SIZE = (480, 360)


def records(group: str) -> dict[str, bytes | None]:
    """ケースごとの属性の中身。None は属性を付けない。"""

    def urls(case: str) -> tuple[str, str]:
        return f"{BASE}/img/{group}-{case}.png", f"{BASE}/page/{group}-{case}"

    def binary(items: list[str]) -> bytes:
        return plistlib.dumps(items, fmt=plistlib.FMT_BINARY)

    lists = {
        "two": list(urls("two")),
        "one": [urls("one")[0]],
        "three": [*urls("three"), f"{BASE}/third/{group}"],
        "empty-second": [urls("empty-second")[0], ""],
        "page-only": ["file:///tmp/a.png", urls("page-only")[1]],
        "image-only": [urls("image-only")[0], "ftp://example.com/page"],
        "non-http": ["ftp://example.com/a.png", "javascript:alert(1)"],
        "invalid": ["壊れた記録", "これも URL ではない"],
    }
    return {
        **{case: binary(items) for case, items in lists.items()},
        "none": None,
        "xml": plistlib.dumps(list(urls("xml")), fmt=plistlib.FMT_XML),
        "garbage": "plist ではない".encode(),
    }


def image(path: Path, seed: int, label: str) -> None:
    color = ((seed * 67) % 200 + 30, (seed * 131) % 200 + 30, (seed * 197) % 200 + 30)
    im = Image.new("RGB", SIZE, color)
    ImageDraw.Draw(im).text((16, 16), label, fill=(255, 255, 255))
    im.save(path, "PNG")


def write_attr(path: Path, data: bytes) -> None:
    subprocess.run(["/usr/bin/xattr", "-wx", ATTR, data.hex(), path], check=True)


def generate(out: Path) -> None:
    if out.exists() and any(out.iterdir()):
        sys.exit(f"{out} が空ではありません。別のフォルダを指定してください")
    seed = 0
    for group in ["import", "finder", "backfill"]:
        (out / group).mkdir(parents=True)
        for case, data in records(group).items():
            seed += 1
            path = out / group / f"{case}.png"
            image(path, seed, f"{group}/{case}")
            if data is not None:
                write_attr(path, data)
    (out / "import-dup").mkdir()
    dup = out / "import-dup" / "two-again.png"
    dup.write_bytes((out / "import" / "two.png").read_bytes())
    write_attr(dup, records("import-dup")["two"])


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("out", type=Path, help="出力先のフォルダ")
    args = parser.parse_args()
    if sys.platform != "darwin":
        sys.exit("macOS の xattr で属性を付けるため、macOS で実行してください")
    generate(args.out)
    print(f"{args.out} に元URLの確認用の画像を作りました")


if __name__ == "__main__":
    main()
