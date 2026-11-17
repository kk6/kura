"""見本の写真から、候補の構成ごとに骨格（COCO 17点）を推定して out/ に保存する。

使い方: uv run pose.py <写真のフォルダ（読み取り専用）> [<写真のフォルダ> ...]
先に uv run fetch.py でモデルを models/ に置く。
"""

import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

HERE = Path(__file__).parent
OUT = HERE / "out"
MODELS_DIR = HERE / "models"
THUMB_WIDTH = 320  # 本体の import.rs と同じ（幅320px、JPEG 品質85）
Image.MAX_IMAGE_PIXELS = None  # 見本に1億画素の写真がある

# Kura のワーカーと同じ1スレッドにそろえる。RTMLib はセッションの設定を渡さないので差し込む
_Session = ort.InferenceSession


def _session(path_or_bytes, providers=None, **_):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    return _Session(path_or_bytes, opts, providers=["CPUExecutionProvider"])


ort.InferenceSession = _session
from rtmlib import RTMO, YOLOX, RTMPose  # noqa: E402  差し込んだ後に読む


def load(path):
    return ImageOps.exif_transpose(Image.open(path)).convert("RGB")


def bgr(img):
    return np.ascontiguousarray(np.asarray(img)[:, :, ::-1])  # RTMLib は cv2.imread と同じ BGR を受け取る


class TopDown:
    def __init__(self, pose):
        # 検出の閾値は RTMLib の既定（0.7）。Body の lightweight と同じ入力 416
        self.det = YOLOX(str(MODELS_DIR / "yolox-tiny.onnx"), model_input_size=(416, 416))
        self.pose = RTMPose(str(MODELS_DIR / f"{pose}.onnx"), model_input_size=(192, 256))

    def __call__(self, img):
        t0 = time.perf_counter()
        boxes = self.det(img)
        t1 = time.perf_counter()
        # 枠が空だと RTMPose は画像全体を1人として推定するので、呼ばない
        if len(boxes) == 0:
            kpts, scores = np.zeros((0, 17, 2)), np.zeros((0, 17))
        else:
            kpts, scores = self.pose(img, bboxes=boxes)
        t2 = time.perf_counter()
        return np.asarray(boxes).reshape(-1, 4), kpts, scores, dict(det=(t1 - t0) * 1000, pose=(t2 - t1) * 1000)


class OneStage:
    def __init__(self):
        self.model = RTMO(str(MODELS_DIR / "rtmo-s.onnx"), model_input_size=(640, 640))

    def __call__(self, img):
        t0 = time.perf_counter()
        kpts, scores = self.model(img)
        t1 = time.perf_counter()
        # 人物がいないと全部0の1人分を返すので、取り除く
        keep = scores.max(axis=1) > 0
        kpts, scores = kpts[keep], scores[keep]
        boxes = np.array([[*k.min(0), *k.max(0)] for k in kpts]).reshape(-1, 4)  # 枠は関節の外接で代える
        return boxes, kpts, scores, dict(det=0.0, pose=(t1 - t0) * 1000)


def main():
    srcs = [Path(a) for a in sys.argv[1:]]
    originals = sorted(
        (src, p) for src in srcs for p in src.rglob("*")
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        and not any(part.startswith(".") for part in p.relative_to(src).parts)  # .kura/ を除く
    )
    (OUT / "thumbs").mkdir(parents=True, exist_ok=True)
    names, sizes, thumbs = [], [], []
    for i, (src, p) in enumerate(originals):
        t = OUT / "thumbs" / f"{i:03d}.jpg"
        img = load(p)
        w, h = img.size
        if w > THUMB_WIDTH:
            img = img.resize((THUMB_WIDTH, round(h * THUMB_WIDTH / w)), Image.BOX)
        img.save(t, quality=85)
        thumbs.append(t)
        names.append(f"{src.name}/{p.relative_to(src)}")
        sizes.append([w, h])
    print(f"{len(names)} images", flush=True)

    configs = {"rtmpose-s": lambda: TopDown("rtmpose-s"), "rtmpose-m": lambda: TopDown("rtmpose-m"), "rtmo-s": OneStage}
    poses, timings = {}, {}
    for name, make in configs.items():
        t0 = time.perf_counter()
        model = make()
        load_ms = (time.perf_counter() - t0) * 1000
        for kind, paths in {"thumb": thumbs, "orig": [p for _, p in originals]}.items():
            out, rec = [], []
            for i, p in enumerate(paths):
                t0 = time.perf_counter()
                img = bgr(load(p))
                t1 = time.perf_counter()
                boxes, kpts, scores, t = model(img)
                total = (time.perf_counter() - t0) * 1000
                h, w = img.shape[:2]
                scale = np.array([w, h])
                out.append(dict(  # 座標は画像の幅・高さで 0〜1 にそろえ、サムネイルと元の画像を比べられるようにする
                    boxes=np.round(boxes.reshape(-1, 2, 2) / scale, 4).reshape(-1, 4).tolist(),
                    kpts=np.round(np.asarray(kpts) / scale, 4).tolist(),
                    scores=np.round(np.asarray(scores), 3).tolist(),
                ))
                rec.append(dict(read=(t1 - t0) * 1000, **t, total=total, people=len(boxes), pixels=w * h))
            poses[f"{name}|{kind}"] = out
            r = rec[3:]  # 最初の3枚は暖機として除く
            med = lambda k, rows=r: round(statistics.median(x[k] for x in rows), 1)  # noqa: E731
            totals = sorted(x["total"] for x in r)
            timings[f"{name}|{kind}"] = dict(
                images=len(rec), session_load_ms=round(load_ms),
                read_ms_median=med("read"), det_ms_median=med("det"), pose_ms_median=med("pose"),
                total_ms_median=med("total"), total_ms_p95=round(totals[int(len(totals) * 0.95)], 1),
                total_ms_mean=round(statistics.mean(totals), 1),
                pose_ms_median_by_people={
                    str(n): med("pose", [x for x in r if min(x["people"], 3) == n])
                    for n in sorted({min(x["people"], 3) for x in r})
                },
                big_images_total_ms_median=(  # 4000万画素を超える写真だけ
                    med("total", [x for x in rec if x["pixels"] > 40e6]) if any(x["pixels"] > 40e6 for x in rec) else None
                ),
                no_person=sum(x["people"] == 0 for x in rec),
            )
            print(name, kind, timings[f"{name}|{kind}"], flush=True)

    (OUT / "poses.json").write_text(json.dumps(dict(names=names, sizes=sizes, poses=poses), ensure_ascii=False))
    (OUT / "timings.json").write_text(json.dumps(timings, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
