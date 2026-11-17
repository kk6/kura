"""公式の配布先から骨格推定のモデルを models/ に取得し、zip から .onnx だけを取り出す。

使い方: uv run fetch.py
"""

import hashlib
import io
import urllib.request
import zipfile
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "models"
BASE = "https://download.openmmlab.com/mmpose/v1/projects"
MODELS = {
    "yolox-tiny": f"{BASE}/rtmposev1/onnx_sdk/yolox_tiny_8xb8-300e_humanart-6f3252f9.zip",
    "rtmpose-s": f"{BASE}/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip",
    "rtmpose-m": f"{BASE}/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip",
    "rtmo-s": f"{BASE}/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip",
}


def main():
    MODELS_DIR.mkdir(exist_ok=True)
    for name, url in MODELS.items():
        dst = MODELS_DIR / f"{name}.onnx"
        if dst.exists():
            continue
        data = urllib.request.urlopen(url, timeout=120).read()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            onnx = [i for i in z.infolist() if i.filename.endswith(".onnx")]
            assert len(onnx) == 1, (name, [i.filename for i in z.infolist()])
            dst.write_bytes(z.read(onnx[0]))  # 中のパスは使わず、決めた名前で書く
        print(f"{name}: zip {len(data)} B sha256 {hashlib.sha256(data).hexdigest()}"
              f" / {onnx[0].filename} {dst.stat().st_size} B sha256 {hashlib.sha256(dst.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
