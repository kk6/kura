import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnx
import pytest
from kura_worker import comp_edge, comp_gray
from onnx import TensorProto, helper, numpy_helper
from PIL import Image

MANIFEST = Path(__file__).parents[1] / "model.json"
ASPECTS = json.loads(MANIFEST.read_text())["aspects"]


def write_fake_model(path: Path, dim: int) -> None:
    """本物と同じ入出力の名前と形を持つ小さな ONNX（画素の平均を dim 次元へ線形に写す）。"""
    rng = np.random.default_rng(0)
    w = numpy_helper.from_array(rng.standard_normal((3, dim)).astype(np.float32), "w")
    b = numpy_helper.from_array(rng.standard_normal(dim).astype(np.float32), "b")
    shape = numpy_helper.from_array(np.array([1, 3], dtype=np.int64), "shape")
    graph = helper.make_graph(
        [
            helper.make_node("GlobalAveragePool", ["pixel_values"], ["pooled"]),
            helper.make_node("Reshape", ["pooled", "shape"], ["flat"]),
            helper.make_node("MatMul", ["flat", "w"], ["proj"]),
            helper.make_node("Add", ["proj", "b"], ["pooler_output"]),
        ],
        "fake",
        [
            helper.make_tensor_value_info(
                "pixel_values", TensorProto.FLOAT, [1, 3, 224, 224]
            )
        ],
        [helper.make_tensor_value_info("pooler_output", TensorProto.FLOAT, [1, dim])],
        [w, b, shape],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.save(model, path)


@pytest.fixture
def model_dir(tmp_path):
    d = tmp_path / "models"
    d.mkdir()
    for a in ASPECTS:
        if a["file"]:
            write_fake_model(d / a["file"]["name"], a["dim"])
    return d


def write_image(path: Path, seed: int) -> Path:
    rng = np.random.default_rng(seed)
    Image.fromarray(rng.integers(0, 256, (240, 320, 3), dtype=np.uint8)).save(path)
    return path


class Worker:
    def __init__(self, model_dir: Path):
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "kura_worker",
                "--manifest",
                str(MANIFEST),
                "--model-dir",
                str(model_dir),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    def read(self) -> dict:
        return json.loads(self.proc.stdout.readline())

    def send(self, line: str) -> None:
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def ask(self, id_: int, path: Path) -> dict:
        self.send(json.dumps({"id": id_, "path": str(path)}))
        return self.read()

    def finish(self) -> int:
        self.proc.stdin.close()
        return self.proc.wait(timeout=30)


@pytest.fixture
def worker(model_dir):
    w = Worker(model_dir)
    yield w
    w.proc.kill()
    w.proc.wait()


def test_ready_lists_aspects_from_manifest(worker):
    ready = worker.read()
    assert ready["ready"] is True
    assert ready["protocol"] == 1
    assert ready["aspects"] == [
        {"aspect": a["aspect"], "model": a["model"], "dim": a["dim"]} for a in ASPECTS
    ]


def test_returns_unit_vector_of_dim_per_aspect(worker, tmp_path):
    worker.read()
    res = worker.ask(1, write_image(tmp_path / "a.jpg", 1))
    assert res["id"] == 1 and res["ok"] is True
    for a in ASPECTS:
        v = np.array(res["features"][a["aspect"]])
        assert v.shape == (a["dim"],)
        assert np.isfinite(v).all()
        assert math.isclose(np.linalg.norm(v), 1.0, abs_tol=1e-5)


def test_composition_dot_is_mean_of_gray_and_edge_cosines(worker, tmp_path):
    worker.read()
    paths = [write_image(tmp_path / f"{i}.png", i) for i in (1, 2)]
    a, b = (
        np.array(worker.ask(i, p)["features"]["composition"])
        for i, p in enumerate(paths, 1)
    )
    imgs = [Image.open(p) for p in paths]

    def cos(f):
        x, y = (f(i) for i in imgs)
        return float(x @ y / np.linalg.norm(x) / np.linalg.norm(y))

    assert math.isclose(a @ b, (cos(comp_gray) + cos(comp_edge)) / 2, abs_tol=1e-5)


def test_unreadable_or_non_image_returns_error_and_keeps_serving(worker, tmp_path):
    worker.read()
    text = tmp_path / "note.jpg"
    text.write_text("画像ではない")
    missing = worker.ask(1, tmp_path / "missing.jpg")
    assert missing["id"] == 1 and missing["ok"] is False and missing["error"]
    broken = worker.ask(2, text)
    assert broken["id"] == 2 and broken["ok"] is False and broken["error"]
    assert worker.ask(3, write_image(tmp_path / "a.jpg", 1))["ok"] is True


def test_exits_zero_when_stdin_closes(worker):
    worker.read()
    assert worker.finish() == 0


def test_missing_model_file_reports_not_ready_and_exits_one(tmp_path):
    w = Worker(tmp_path)
    ready = w.read()
    assert ready["ready"] is False and ready["error"]
    assert w.proc.wait(timeout=30) == 1


def test_exits_one_on_malformed_request(worker):
    worker.read()
    worker.send("{not json")
    assert worker.proc.wait(timeout=30) == 1


def test_exits_one_when_request_lacks_path(worker):
    worker.read()
    worker.send(json.dumps({"id": 1}))
    assert worker.proc.wait(timeout=30) == 1


def test_does_not_modify_image(worker, tmp_path):
    worker.read()
    path = write_image(tmp_path / "a.jpg", 1)
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    assert worker.ask(1, path)["ok"] is True
    assert worker.finish() == 0
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
