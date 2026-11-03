# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow"]
# ///
"""開発とテスト用に、Finder で整理した資料フォルダに似たダミー画像のフォルダを作る。

使い方：uv run scripts/gen_dev_library.py <枚数> [--out <出力先>]   （出力先の既定は dev-library/）

- 入れ子のカテゴリ用フォルダに、JPEG・PNG・WebP・GIF の画像を振り分ける。縦長を多めに、横長と正方形を混ぜる
- 取り込みの例外を確かめるためのファイルも置く：中身が同じ画像、対応していない形式、隠しファイル、空のフォルダ
- 同じ枚数なら毎回同じ中身になる
"""

import argparse
import random
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "dev-library"
FOLDERS = [
    "ポーズ/座り",
    "ポーズ/立ち",
    "ポーズ/振り返り",
    "服飾",
    "背景/屋外",
    "背景/室内",
    "手",
]
EMPTY_FOLDER = "背景/空のフォルダ"
FORMATS = (
    [("jpg", "JPEG")] * 6 + [("png", "PNG")] * 2 + [("webp", "WEBP"), ("gif", "GIF")]
)
RATIOS = [(2, 3)] * 5 + [(3, 4)] * 3 + [(1, 1)] * 2 + [(4, 3)] * 2 + [(16, 9)]
LONG_SIDE = (600, 1200)
DUPLICATES = 3


def plan(i: int) -> tuple[Path, tuple[int, int], str]:
    rnd = random.Random(i)
    w, h = rnd.choice(RATIOS)
    scale = rnd.randrange(*LONG_SIDE) / max(w, h)
    ext, fmt = rnd.choice(FORMATS)
    return (
        Path(rnd.choice(FOLDERS)) / f"ref_{i:05d}.{ext}",
        (round(w * scale), round(h * scale)),
        fmt,
    )


def make(args: tuple[Path, int]) -> None:
    out, i = args
    rel, (w, h), fmt = plan(i)
    rnd = random.Random(i)
    im = Image.new("RGB", (w, h), tuple(rnd.randrange(40, 220) for _ in range(3)))
    draw = ImageDraw.Draw(im)
    for _ in range(6):
        x, y, r = rnd.randrange(w), rnd.randrange(h), rnd.randrange(20, 200)
        draw.ellipse(
            (x - r, y - r, x + r, y + r),
            fill=tuple(rnd.randrange(256) for _ in range(3)),
        )
    im = Image.blend(im, Image.effect_noise((w, h), 40).convert("RGB"), 0.25)
    im.save(out / rel, fmt, **({"quality": 85} if fmt in ("JPEG", "WEBP") else {}))


def generate(count: int, out: Path) -> None:
    if out.exists() and any(out.iterdir()):
        sys.exit(f"{out} が空ではありません。消してから実行してください")
    for folder in [*FOLDERS, EMPTY_FOLDER]:
        (out / folder).mkdir(parents=True, exist_ok=True)
    with ProcessPoolExecutor() as pool:
        list(pool.map(make, [(out, i) for i in range(count)], chunksize=100))

    for i in range(min(DUPLICATES, count)):
        src = out / plan(i)[0]
        (out / "_重複" / src.name).parent.mkdir(exist_ok=True)
        (out / "_重複" / src.name).write_bytes(src.read_bytes())
    (out / "服飾" / "対応外の形式.heic").write_bytes(b"not an image")
    (out / "服飾" / "メモ.txt").write_text("画像ではないファイル\n", encoding="utf-8")
    (out / "ポーズ" / ".hidden.jpg").write_bytes(
        (out / plan(0)[0]).read_bytes() if count else b""
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("count", type=int, help="生成する画像の枚数")
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT, help="出力先（既定：dev-library/）"
    )
    args = parser.parse_args()
    if args.count < 0:
        parser.error("枚数は0以上にしてください")
    generate(args.count, args.out)
    print(f"{args.out} に {args.count} 枚を生成しました")


if __name__ == "__main__":
    main()
