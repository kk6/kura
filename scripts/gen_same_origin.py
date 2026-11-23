# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow"]
# ///
"""元が同じ画像（FR-610、FR-611）のしきい値を測るために、見本の写真から変形した写しを作る。

使い方：uv run scripts/gen_same_origin.py <見本の写真のフォルダ> <出力先>

- 見本の写真のフォルダ（入れ子も見る）の JPEG・PNG・WebP を読むだけにし、中身は変えない
- 写真ごとに <出力先>/<番号>/ を作り、元の写真の写し original.<拡張子> と、変形した写し（VARIANTS の名前.jpg）を置く
- 変形は縮小、トリミング、彩度と明るさの変更、JPEG の再圧縮。左右反転は「元が同じ」に含めないので作らない
- 同じ入力なら毎回同じ中身になる
"""

import argparse
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

EXTS = {".jpg", ".jpeg", ".png", ".webp"}
# 変形以外の劣化を小さくするため、再圧縮の変形のほかは高い品質で保存する
QUALITY = 95
RECOMPRESS_QUALITY = 50


def scale(k):
    return lambda im, _i: im.resize(
        (max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS
    )


def crop(k):
    # 中央より値が崩れやすい隅に寄せて切る。どの隅かは写真ごとに回す
    def f(im, i):
        w, h = round(im.width * k), round(im.height * k)
        x = (im.width - w) * (i % 2)
        y = (im.height - h) * (i // 2 % 2)
        return im.crop((x, y, x + w, y + h))

    return f


def enhance(cls, k):
    return lambda im, _i: cls(im).enhance(k)


VARIANTS = {
    "scale50": scale(0.5),
    "scale25": scale(0.25),
    "crop90": crop(0.9),
    "crop75": crop(0.75),
    "saturation60": enhance(ImageEnhance.Color, 0.6),
    "saturation140": enhance(ImageEnhance.Color, 1.4),
    "brightness80": enhance(ImageEnhance.Brightness, 0.8),
    "brightness120": enhance(ImageEnhance.Brightness, 1.2),
    "recompress": lambda im, _i: im,
}


def photos(src: Path) -> list[Path]:
    return sorted(
        p
        for p in src.rglob("*")
        if p.suffix.lower() in EXTS
        and not any(part.startswith(".") for part in p.relative_to(src).parts)
    )


def make(args: tuple[Path, Path, int]) -> None:
    path, out, i = args
    dest = out / f"{i:04d}"
    dest.mkdir()
    shutil.copyfile(path, dest / f"original{path.suffix.lower()}")
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    for name, f in VARIANTS.items():
        q = RECOMPRESS_QUALITY if name == "recompress" else QUALITY
        f(im, i).save(dest / f"{name}.jpg", "JPEG", quality=q)


def generate(src: Path, out: Path) -> int:
    if out.exists() and any(out.iterdir()):
        sys.exit(f"{out} が空ではありません。消してから実行してください")
    out.mkdir(parents=True, exist_ok=True)
    paths = photos(src)
    with ProcessPoolExecutor() as pool:
        list(pool.map(make, [(p, out, i) for i, p in enumerate(paths)]))
    return len(paths)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("src", type=Path, help="見本の写真のフォルダ（読むだけ）")
    parser.add_argument("out", type=Path, help="出力先（空のフォルダか、ない場所）")
    args = parser.parse_args()
    if args.out.resolve().is_relative_to(args.src.resolve()):
        parser.error("出力先を見本の写真のフォルダの外にしてください")
    n = generate(args.src, args.out)
    print(f"{args.out} に {n} 枚の写真から変形した写しを作りました")


if __name__ == "__main__":
    main()
