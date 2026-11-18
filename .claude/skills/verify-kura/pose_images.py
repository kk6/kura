"""ポーズの確認用の画像を、人物の写真の写しから作る（features/similarity.md の「ポーズの確認用のライブラリ」）。

使い方：ml/.venv/bin/python -I .claude/skills/verify-kura/pose_images.py <人物の写真のフォルダ> <ライブラリ> [枚数] [変形の数]

- <ライブラリ>/脚/ に、写真の下の40%を切り出した画像を置く。人物の枠は出ても関節が足りず、
  2割ほどが「関節が足りない」（features.db の poses の status 1）になる（2026-11-18、見本の人物の写真40枚で9枚）
- <ライブラリ>/反転/ に、写真を左右反転した画像を置く。元の写真を基準にして体の姿勢を重くすると、上に来る
- <ライブラリ>/組/ に、隣り合う2枚を高さをそろえて横に並べた画像を置く（2人が写った画像の代わり）。
  どちらかの元の写真を基準にすると、上に来る
- [変形の数] を渡すと、<ライブラリ>/変形/ に、写真ごとにその数だけ、少しずつ違う位置で切り抜いた画像を置く（ポーズのある画像を
  2万枚のライブラリに数千枚混ぜて、ポーズの比べ方の時間を測るため）。乱数の種は写真と番号で決まり、何度作っても同じ画像になる
- 元のフォルダには書かない。名前は元の名前の前に legs-、flip-、pair-、var<番号>- を付ける
"""

import random
import sys
from pathlib import Path

from PIL import Image, ImageOps


def main() -> None:
    src, lib = Path(sys.argv[1]), Path(sys.argv[2])
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    variants = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    legs, flip, pair = lib / "脚", lib / "反転", lib / "組"
    for d in (legs, flip, pair):
        d.mkdir(parents=True, exist_ok=True)
    paths = sorted(src.glob("*.jpg"))[:count]
    for a, b in zip(paths[::2], paths[1::2]):
        with Image.open(a) as ia, Image.open(b) as ib:
            h = min(ia.height, ib.height)
            ia, ib = (im.resize((im.width * h // im.height, h)) for im in (ia, ib))
            out = Image.new("RGB", (ia.width + ib.width, h))
            out.paste(ia, (0, 0))
            out.paste(ib, (ia.width, 0))
            out.save(pair / f"pair-{a.stem}+{b.stem}.jpg", quality=90)
    for path in paths:
        with Image.open(path) as im:
            w, h = im.size
            im.crop((0, int(h * 0.6), w, h)).save(
                legs / f"legs-{path.name}", quality=90
            )
            ImageOps.mirror(im).save(flip / f"flip-{path.name}", quality=90)
    print(f"{legs}、{flip} に {len(paths)} 枚ずつ、{pair} に {len(paths) // 2} 枚")
    if variants:
        var = lib / "変形"
        var.mkdir(exist_ok=True)
        for path in paths:
            with Image.open(path) as im:
                # 先に縮めておき、変形ごとの切り抜きと保存を軽くする
                im = im.convert("RGB")
                im.thumbnail((640, 640))
                w, h = im.size
                for i in range(variants):
                    r = random.Random(f"{path.name}:{i}")
                    box = (
                        int(w * r.uniform(0, 0.1)),
                        int(h * r.uniform(0, 0.1)),
                        int(w * r.uniform(0.9, 1)),
                        int(h * r.uniform(0.9, 1)),
                    )
                    im.crop(box).save(var / f"var{i:03}-{path.name}", quality=85)
        print(f"{var} に {len(paths) * variants} 枚")


if __name__ == "__main__":
    main()
