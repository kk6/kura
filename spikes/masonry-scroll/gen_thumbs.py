# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow"]
# ///
"""ダミーのサムネイルを生成する。

使い方：uv run gen_thumbs.py [枚数]   （既定 20000）
出力：.data/thumbs/<番号>.jpg と .data/manifest.json（各画像の [幅, 高さ]）
サムネイルは幅320px。縦長を多めに、横長と正方形を混ぜる。ノイズを入れて実際の写真に近いファイルサイズにする。
"""

import json
import random
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / ".data"
WIDTH = 320
RATIOS = [(2, 3)] * 5 + [(3, 4)] * 3 + [(1, 1)] * 2 + [(4, 3)] * 2 + [(16, 9)]


def size_of(i: int) -> tuple[int, int]:
    w, h = random.Random(i).choice(RATIOS)
    return WIDTH, round(WIDTH * h / w)


def make(i: int) -> None:
    w, h = size_of(i)
    rnd = random.Random(i)
    base = tuple(rnd.randrange(40, 220) for _ in range(3))
    im = Image.new("RGB", (w, h), base)
    draw = ImageDraw.Draw(im)
    for _ in range(6):
        x, y = rnd.randrange(w), rnd.randrange(h)
        r = rnd.randrange(20, 120)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=tuple(rnd.randrange(256) for _ in range(3)))
    noise = Image.effect_noise((w, h), 40).convert("RGB")
    Image.blend(im, noise, 0.25).save(OUT / "thumbs" / f"{i}.jpg", quality=80)


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    (OUT / "thumbs").mkdir(parents=True, exist_ok=True)
    with ProcessPoolExecutor() as pool:
        list(pool.map(make, range(n), chunksize=200))
    (OUT / "manifest.json").write_text(json.dumps([size_of(i) for i in range(n)]))


if __name__ == "__main__":
    main()
