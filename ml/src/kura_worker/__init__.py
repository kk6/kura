"""Kura の特徴量ワーカー。

標準入力から1行1件の JSON（{"id": ..., "path": ..., "aspects": [...]}）を受け取り、観点ごとの特徴量
（長さ1のベクトルか、ポーズ）を標準出力に1行1件の JSON で返す。画像は読むだけで、ファイルも DB も変更しない。
やりとりの形は docs/tasks/phase3-design.md の1章と5章（protocol 2）。
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

PROTOCOL = 2


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


def session(path, threads):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    return ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])


def composition(_paths, _threads):
    # 長さ1の2つを 1/√2 倍してつなぐと、内積が2つのコサイン類似度の平均になる
    return lambda img: np.concatenate([comp_gray(img), comp_edge(img)]) / np.sqrt(2)


def siglip2(paths, threads):
    sess = session(paths[0], threads)
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


# ポーズの数は spikes/pose の値（RTMLib 0.0.16 の前後処理）。色の順だけは配布物の pipeline.json に合わせる。変えたら model.json の model の名前も変える
DET_SIZE = 416
DET_SCORE = 0.3
POSE_W, POSE_H = 192, 256
POSE_MEAN = np.array((123.675, 116.28, 103.53), dtype=np.float32)
POSE_STD = np.array((58.395, 57.12, 57.375), dtype=np.float32)
SIMCC_SPLIT = 2.0
JOINT_SCORE = 0.3
MIN_JOINTS = 6


def detect(sess, img):
    """YOLOX（NMS 込みの ONNX）で人物の枠 [x1, y1, x2, y2] を画像の座標で返す。"""
    w, h = img.size
    ratio = min(DET_SIZE / h, DET_SIZE / w)
    canvas = Image.new("RGB", (DET_SIZE, DET_SIZE), (114, 114, 114))
    canvas.paste(img.resize((int(w * ratio), int(h * ratio)), Image.BILINEAR))
    # 配布物の pipeline.json は to_rgb: false。BGR の 0〜255 をそのまま渡す
    x = np.asarray(canvas, dtype=np.float32)[:, :, ::-1].transpose(2, 0, 1)[None]
    dets = sess.run(["dets"], {"input": np.ascontiguousarray(x)})[0][0]
    return dets[dets[:, 4] > DET_SCORE, :4] / ratio


def crop(img, box):
    """枠を1.25倍に広げ、192:256 にそろえて切り出す。返り値は骨格のモデルの入力と、中心と、1画素あたりの元の画像の大きさ。"""
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    bw, bh = (x2 - x1) * 1.25, (y2 - y1) * 1.25
    bw = max(bw, bh * POSE_W / POSE_H)
    k = bw / POSE_W
    # cv2.warpAffine（画素の中心が整数）と同じ写し方を、Pillow（画素の中心が +0.5）の逆写像で書く
    data = (
        k,
        0,
        cx + 0.5 - k * (POSE_W / 2 + 0.5),
        0,
        k,
        cy + 0.5 - k * (POSE_H / 2 + 0.5),
    )
    out = img.transform((POSE_W, POSE_H), Image.AFFINE, data, Image.BILINEAR)
    # 配布物の pipeline.json は to_rgb: true。RTMLib（とスパイク）は BGR のまま渡すが、学習時の RGB に合わせる
    x = (np.asarray(out, dtype=np.float32) - POSE_MEAN) / POSE_STD
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None]), (cx, cy), k


def rtmpose(paths, threads):
    det, pose = (
        session(p, threads) for p in paths
    )  # model.json の files の順（人物の検出、骨格）

    def estimate(img):
        img = img.convert("RGB")
        boxes = detect(det, img)
        if len(boxes) == 0:
            return {"status": "none", "people": []}
        crops = [crop(img, b) for b in boxes]
        # 人物ごとに1回ずつ流す。1スレッドではまとめて流すと2倍遅い（4人で 147ms と 70ms）
        outs = [pose.run(["simcc_x", "simcc_y"], {"input": x}) for x, _, _ in crops]
        sx, sy = (np.concatenate(o) for o in zip(*outs))
        scores = (sx.max(axis=2) + sy.max(axis=2)) / 2
        locs = np.stack([sx.argmax(axis=2), sy.argmax(axis=2)], axis=-1) / SIMCC_SPLIT
        locs[scores <= 0] = -1  # RTMLib と同じ。スコアが0以下の関節は位置を持たない
        long_side = max(img.size)
        people = []
        for (_, (cx, cy), k), loc, score in zip(crops, locs, scores):
            if (score >= JOINT_SCORE).sum() < MIN_JOINTS:
                continue
            xy = (loc - (POSE_W / 2, POSE_H / 2)) * k + (cx, cy)
            people.append(np.column_stack([xy / long_side, score]).ravel().tolist())
        return {"status": "ok" if people else "few", "people": people}

    return estimate


# model.json の model の名前ごとの計算。モデルを変えたら名前も変える（features.db の古い行の目印になる）
MODELS = {
    "siglip2-base-patch16-224": siglip2,
    "gray16-edge4x8-v1": composition,
    "rtmpose-m-body7-yolox-tiny-humanart-v1": rtmpose,
}


def start(manifest_path, model_dir, names):
    """names の観点だけを読み込み、観点の名前から (model.json の項目, 計算) を引く dict を返す。"""
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    by_name = {a["aspect"]: a for a in manifest["aspects"]}
    aspects = {}
    for name in names:
        if name not in by_name:
            raise ValueError(f"model.json にない観点です: {name}")
        a = by_name[name]
        if a["model"] not in MODELS:
            raise ValueError(f"知らないモデルです: {a['model']}")
        paths = [Path(model_dir) / f["name"] for f in a["files"]]
        for path in paths:
            if not path.is_file():
                raise FileNotFoundError(f"モデルのファイルがありません: {path}")
        aspects[name] = (
            a,
            MODELS[a["model"]]([str(p) for p in paths], manifest["threads"]),
        )
    return aspects


def compute(aspects, img, names):
    features = {}
    for name in names:
        v = aspects[name][1](img)
        features[name] = v.tolist() if isinstance(v, np.ndarray) else v
    return features


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(prog="kura-worker")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--aspects", required=True)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    try:
        aspects = start(args.manifest, args.model_dir, args.aspects.split(","))
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
                {k: a[k] for k in ("aspect", "model", "kind", "dim")}
                for a, _ in aspects.values()
            ],
        }
    )

    for line in sys.stdin:
        try:
            req = json.loads(line)
            id_, path, names = req["id"], req["path"], req["aspects"]
            if not isinstance(names, list) or not names:
                raise TypeError("aspects が1つ以上の観点の配列ではありません")
            for name in names:
                if name not in aspects:
                    raise KeyError(f"起動していない観点です: {name}")
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
        reply({"id": id_, "ok": True, "features": compute(aspects, img, names)})
