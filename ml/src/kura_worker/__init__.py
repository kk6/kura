"""Kura の特徴量ワーカー。

標準入力から1行1件の JSON（{"id": ..., "path": ...}）を受け取り、観点ごとの長さ1のベクトルを
標準出力に1行1件の JSON で返す。画像は読むだけで、ファイルも DB も変更しない。
やりとりの形は docs/tasks/phase3-design.md の1章。
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

PROTOCOL = 1


def load(path):
    img = ImageOps.exif_transpose(Image.open(path))
    img.load()
    return img


def comp_gray(img, n=16):
    g = np.asarray(
        img.convert("L").resize((n, n), Image.BILINEAR), dtype=np.float32
    ).ravel()
    g = g - g.mean()
    return g / (np.linalg.norm(g) + 1e-6)


def comp_edge(img, size=128, grid=4, bins=8):
    g = np.asarray(
        img.convert("L").resize((size, size), Image.BILINEAR), dtype=np.float32
    )
    gx, gy = np.zeros_like(g), np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    mag = np.hypot(gx, gy)
    b = np.minimum((np.arctan2(gy, gx) % np.pi / np.pi * bins).astype(int), bins - 1)
    cell = size // grid
    hist = [
        np.bincount(
            b[y : y + cell, x : x + cell].ravel(),
            weights=mag[y : y + cell, x : x + cell].ravel(),
            minlength=bins,
        )
        for y in range(0, size, cell)
        for x in range(0, size, cell)
    ]
    v = np.concatenate(hist).astype(np.float32)
    return v / (np.linalg.norm(v) + 1e-6)


def composition(_model_path, _threads):
    # 長さ1の2つを 1/√2 倍してつなぐと、内積が2つのコサイン類似度の平均になる
    return lambda img: np.concatenate([comp_gray(img), comp_edge(img)]) / np.sqrt(2)


def siglip2(model_path, threads):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    sess = ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])
    half = np.array((0.5, 0.5, 0.5), dtype=np.float32)

    def embed(img):
        # SigLIP は縦横比を無視して 224x224 に縮める（preprocessor_config.json と同じ）
        x = (
            np.asarray(
                img.convert("RGB").resize((224, 224), Image.BILINEAR), dtype=np.float32
            )
            / 255.0
        )
        x = ((x - half) / half).transpose(2, 0, 1)[None]
        v = sess.run(["pooler_output"], {sess.get_inputs()[0].name: x})[0][0]
        return v / np.linalg.norm(v)

    return embed


# model.json の model の名前ごとの計算。モデルを変えたら名前も変える（features.db の古い行の目印になる）
MODELS = {
    "siglip2-base-patch16-224": siglip2,
    "gray16-edge4x8-v1": composition,
}


def start(manifest_path, model_dir):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    aspects = []
    for a in manifest["aspects"]:
        if a["model"] not in MODELS:
            raise ValueError(f"知らないモデルです: {a['model']}")
        path = None
        if a["file"]:
            path = Path(model_dir) / a["file"]["name"]
            if not path.is_file():
                raise FileNotFoundError(f"モデルのファイルがありません: {path}")
        aspects.append(
            (a, MODELS[a["model"]](str(path) if path else None, manifest["threads"]))
        )
    return aspects


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(prog="kura-worker")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    try:
        aspects = start(args.manifest, args.model_dir)
    # 起動の失敗はどれも Rust に理由を渡して終わる。ONNX Runtime は壊れたモデルで Exception 直下の独自の例外を出すため、広く受ける
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        reply({"ready": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)
    reply(
        {
            "ready": True,
            "protocol": PROTOCOL,
            "aspects": [
                {"aspect": a["aspect"], "model": a["model"], "dim": a["dim"]}
                for a, _ in aspects
            ],
        }
    )

    for line in sys.stdin:
        try:
            req = json.loads(line)
            id_, path = req["id"], req["path"]
        # 決まりと違う要求は Rust 側の不具合なので、続けずに終わる
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            print(f"kura-worker: 要求を読めません: {e}: {line!r}", file=sys.stderr)
            sys.exit(1)
        try:
            img = load(path)
        # 読めない・画像でないファイル（UnidentifiedImageError も OSError）。1枚の失敗でワーカーを止めない
        except OSError as e:
            reply({"id": id_, "ok": False, "error": f"{type(e).__name__}: {e}"})
            continue
        features = {a["aspect"]: f(img).tolist() for a, f in aspects}
        reply({"id": id_, "ok": True, "features": features})
