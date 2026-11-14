"""見本の写真から、候補モデルごとの埋め込みと構図の特徴量を計算して out/ に保存する。

使い方: uv run features.py <見本の写真のフォルダ（読み取り専用）>
"""

import json
import os
import statistics
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

HERE = Path(__file__).parent
OUT = HERE / "out"
MODELS_DIR = HERE / "models"
THUMB_WIDTH = 320  # 本体の import.rs と同じ（幅320px、JPEG 品質85）

CLIP_MEAN, CLIP_STD = (0.48145466, 0.4578275, 0.40821073), (0.26862954, 0.26130258, 0.27577711)
IMNET_MEAN, IMNET_STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
HALF = (0.5, 0.5, 0.5)

# 前処理は各リポジトリの preprocessor_config.json に合わせた
MODELS = {
    "clip-b32": dict(repo="Xenova/clip-vit-base-patch32", file="onnx/vision_model.onnx",
                     short=224, interp=Image.BICUBIC, mean=CLIP_MEAN, std=CLIP_STD),
    "siglip2-b16": dict(repo="onnx-community/siglip2-base-patch16-224-ONNX", file="onnx/vision_model.onnx",
                        short=None, interp=Image.BILINEAR, mean=HALF, std=HALF),
    "dinov2-s": dict(repo="onnx-community/dinov2-small", file="onnx/model.onnx",
                     short=256, interp=Image.BICUBIC, mean=IMNET_MEAN, std=IMNET_STD),
    "dinov2-b": dict(repo="onnx-community/dinov2-base", file="onnx/model.onnx",
                     short=256, interp=Image.BICUBIC, mean=IMNET_MEAN, std=IMNET_STD),
}


def model_path(name):
    m = MODELS[name]
    path = MODELS_DIR / f"{name}.onnx"
    if not path.exists():
        MODELS_DIR.mkdir(exist_ok=True)
        url = f"https://huggingface.co/{m['repo']}/resolve/main/{m['file']}"
        print(f"download {url}", flush=True)
        urllib.request.urlretrieve(url, path.with_suffix(".part"))
        path.with_suffix(".part").rename(path)
    return path


def preprocess(img, m):
    img = img.convert("RGB")
    if m["short"] is None:  # SigLIP は縦横比を無視して 224x224 に縮める
        img = img.resize((224, 224), m["interp"])
    else:
        w, h = img.size
        s = m["short"] / min(w, h)
        img = img.resize((max(224, round(w * s)), max(224, round(h * s))), m["interp"])
        w, h = img.size
        left, top = (w - 224) // 2, (h - 224) // 2
        img = img.crop((left, top, left + 224, top + 224))
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array(m["mean"], dtype=np.float32)) / np.array(m["std"], dtype=np.float32)
    return x.transpose(2, 0, 1)[None]


def embed(sess, x):
    outs = dict(zip([o.name for o in sess.get_outputs()], sess.run(None, {sess.get_inputs()[0].name: x})))
    for key in ("image_embeds", "pooler_output"):
        if key in outs:
            v = outs[key][0]
            break
    else:
        v = outs["last_hidden_state"][0, 0]  # CLS トークン
    return v / np.linalg.norm(v)


def comp_gray(img, n=16):
    g = np.asarray(img.convert("L").resize((n, n), Image.BILINEAR), dtype=np.float32).ravel()
    g = g - g.mean()
    return g / (np.linalg.norm(g) + 1e-6)


def comp_edge(img, size=128, grid=4, bins=8):
    g = np.asarray(img.convert("L").resize((size, size), Image.BILINEAR), dtype=np.float32)
    gx, gy = np.zeros_like(g), np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    mag = np.hypot(gx, gy)
    b = np.minimum((np.arctan2(gy, gx) % np.pi / np.pi * bins).astype(int), bins - 1)
    cell = size // grid
    hist = [
        np.bincount(b[y:y + cell, x:x + cell].ravel(), weights=mag[y:y + cell, x:x + cell].ravel(), minlength=bins)
        for y in range(0, size, cell) for x in range(0, size, cell)
    ]
    v = np.concatenate(hist).astype(np.float32)
    return v / (np.linalg.norm(v) + 1e-6)


def load(path):
    return ImageOps.exif_transpose(Image.open(path))


def main():
    src = Path(sys.argv[1])
    originals = sorted(
        p for p in src.rglob("*")
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        and not any(part.startswith(".") for part in p.relative_to(src).parts)  # .kura/ を除く
    )
    (OUT / "thumbs").mkdir(parents=True, exist_ok=True)
    thumbs = []
    for i, p in enumerate(originals):
        t = OUT / "thumbs" / f"{i:03d}.jpg"
        img = load(p).convert("RGB")
        w, h = img.size
        if w > THUMB_WIDTH:
            img = img.resize((THUMB_WIDTH, round(h * THUMB_WIDTH / w)), Image.BOX)
        img.save(t, quality=85)
        thumbs.append(t)
    sets = {"thumb": thumbs, "orig": originals}
    feats, timings = {}, {}

    for kind, paths in sets.items():
        imgs = [load(p) for p in paths]
        feats[f"gray|{kind}"] = np.stack([comp_gray(i) for i in imgs])
        feats[f"edge|{kind}"] = np.stack([comp_edge(i) for i in imgs])
        if kind == "thumb":
            t0 = time.perf_counter()
            for i in imgs:
                comp_gray(i), comp_edge(i)
            timings["composition_ms_per_image"] = (time.perf_counter() - t0) / len(imgs) * 1000

    for name, m in MODELS.items():
        path = model_path(name)
        for threads in (0, 1):  # 0 は ONNX Runtime の既定（全コア）
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = threads
            t0 = time.perf_counter()
            sess = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
            load_ms = (time.perf_counter() - t0) * 1000
            for kind, paths in sets.items():
                if threads == 1 and kind == "orig":
                    continue
                vecs, pre, inf = [], [], []
                for p in paths:
                    t0 = time.perf_counter()
                    x = preprocess(load(p), m)
                    t1 = time.perf_counter()
                    vecs.append(embed(sess, x))
                    t2 = time.perf_counter()
                    pre.append((t1 - t0) * 1000)
                    inf.append((t2 - t1) * 1000)
                assert len(vecs) == len(paths) and all(np.isfinite(v).all() for v in vecs)
                if threads == 0:
                    feats[f"{name}|{kind}"] = np.stack(vecs)
                timings[f"{name}|{kind}|threads={threads or os.cpu_count()}"] = dict(
                    images=len(vecs), dim=int(vecs[0].shape[0]), session_load_ms=round(load_ms),
                    # 最初の3枚は暖機として除く
                    read_and_preprocess_ms_median=round(statistics.median(pre[3:]), 2),
                    inference_ms_median=round(statistics.median(inf[3:]), 2),
                    inference_ms_min_max=[round(min(inf[3:]), 2), round(max(inf[3:]), 2)],
                    model_mb=round(path.stat().st_size / 1e6, 1),
                )
                print(name, kind, threads, timings[f"{name}|{kind}|threads={threads or os.cpu_count()}"], flush=True)

    np.savez(OUT / "feats.npz", **feats)
    (OUT / "names.json").write_text(json.dumps([str(p.relative_to(src)) for p in originals], ensure_ascii=False))
    (OUT / "timings.json").write_text(json.dumps(timings, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
