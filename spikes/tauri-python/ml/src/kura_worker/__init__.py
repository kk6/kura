"""スパイク用の特徴量ワーカー。

標準入力から1行1件のJSON（{"id": ..., "path": ...}）を受け取り、
標準出力に1行1件のJSONで結果を返す。画像は読むだけで、ファイルもDBも変更しない。
"""

import json
import sys
import time

from PIL import Image


def analyze(path: str) -> dict:
    with Image.open(path) as im:
        small = im.convert("RGB").resize((1, 1), Image.Resampling.BOX)
        return {"width": im.width, "height": im.height, "mean_rgb": list(small.getpixel((0, 0)))}


def main() -> None:
    print(json.dumps({"ready": True, "python": sys.version.split()[0]}), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        started = time.perf_counter()
        try:
            res = {"id": req["id"], "ok": True, **analyze(req["path"])}
        except OSError as e:  # 読めない・画像でないファイル（UnidentifiedImageError も OSError）。1枚の失敗でワーカーを止めないため
            res = {"id": req["id"], "ok": False, "error": str(e)}
        res["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
        print(json.dumps(res), flush=True)
