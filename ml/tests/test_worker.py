import json
import math
import subprocess
import sys
from pathlib import Path

import kura_worker
import numpy as np
import onnx
import onnxruntime as ort
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


def save(graph, path: Path) -> None:
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.save(model, path)


def write_fake_detector(path: Path, dets: list) -> None:
    """YOLOX（NMS 込み）と同じ入出力の偽物。入力によらず dets（416×416 の入力上の [x1, y1, x2, y2, スコア]）を返す。"""
    d = np.array(dets, dtype=np.float32).reshape(1, -1, 5)
    graph = helper.make_graph(
        [
            helper.make_node(
                "Constant", [], ["dets"], value=numpy_helper.from_array(d)
            ),
            helper.make_node(
                "Constant",
                [],
                ["labels"],
                value=numpy_helper.from_array(np.zeros(d.shape[:2], dtype=np.int64)),
            ),
        ],
        "fake_det",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 416, 416])],
        [
            helper.make_tensor_value_info("dets", TensorProto.FLOAT, [1, None, 5]),
            helper.make_tensor_value_info("labels", TensorProto.INT64, [1, None]),
        ],
    )
    save(graph, path)


def write_fake_pose(path: Path, channels=(1 / 3, 1 / 3, 1 / 3)) -> None:
    """RTMPose と同じ入出力の偽物。17点とも切り出しの中心に山を置き、山の高さは切り出しの画素の平均（正規化後）を
    入力のチャンネルごとに channels で重み付けした和。明るい人物はスコアが高く、暗い人物はスコアが0以下になる。"""
    x = np.zeros((1, 17, 384), dtype=np.float32)
    x[..., 192] = 1  # SimCC は入力の2倍の細かさ。192 は幅192の中心
    y = np.zeros((1, 17, 512), dtype=np.float32)
    y[..., 256] = 1
    graph = helper.make_graph(
        [
            helper.make_node(
                "ReduceMean", ["input"], ["mean"], axes=[2, 3], keepdims=0
            ),
            helper.make_node("MatMul", ["mean", "w"], ["weighted"]),
            helper.make_node("Reshape", ["weighted", "shape"], ["m"]),
            helper.make_node("Mul", ["m", "x"], ["simcc_x"]),
            helper.make_node("Mul", ["m", "y"], ["simcc_y"]),
        ],
        "fake_pose",
        [
            helper.make_tensor_value_info(
                "input", TensorProto.FLOAT, ["batch", 3, 256, 192]
            )
        ],
        [
            helper.make_tensor_value_info(
                "simcc_x", TensorProto.FLOAT, ["batch", 17, 384]
            ),
            helper.make_tensor_value_info(
                "simcc_y", TensorProto.FLOAT, ["batch", 17, 512]
            ),
        ],
        [
            numpy_helper.from_array(x, "x"),
            numpy_helper.from_array(y, "y"),
            numpy_helper.from_array(np.array(channels, dtype=np.float32)[:, None], "w"),
            numpy_helper.from_array(np.array([-1, 1, 1], dtype=np.int64), "shape"),
        ],
    )
    save(graph, path)


POSE = next(a for a in ASPECTS if a["aspect"] == "pose")
# 試しの画像は 320×240。人物の検出の入力（416×416）へは 1.3 倍で写る
RATIO = 416 / 320


def write_models(d: Path, dets=((40, 30, 100, 200, 0.9),), channels=None) -> Path:
    d.mkdir(exist_ok=True)
    for a in ASPECTS:
        if a["kind"] == "vector" and a["files"]:
            write_fake_model(d / a["files"][0]["name"], a["dim"])
    detector, pose = POSE["files"]  # 人物の検出、骨格の順
    write_fake_detector(
        d / detector["name"], [[*(v * RATIO for v in b[:4]), b[4]] for b in dets]
    )
    write_fake_pose(d / pose["name"], *([channels] if channels else []))
    return d


@pytest.fixture
def model_dir(tmp_path):
    return write_models(tmp_path / "models")


def write_image(path: Path, seed: int) -> Path:
    rng = np.random.default_rng(seed)
    Image.fromarray(rng.integers(0, 256, (240, 320, 3), dtype=np.uint8)).save(path)
    return path


def write_halves(path: Path) -> Path:
    """左半分が白、右半分が黒の 320×240。"""
    a = np.zeros((240, 320, 3), dtype=np.uint8)
    a[:, :160] = 255
    Image.fromarray(a).save(path)
    return path


ALL = [a["aspect"] for a in ASPECTS]


class Worker:
    def __init__(self, model_dir: Path, aspects=ALL):
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "kura_worker",
                "--manifest",
                str(MANIFEST),
                "--model-dir",
                str(model_dir),
                "--aspects",
                ",".join(aspects),
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

    def ask(self, id_: int, path: Path, aspects=ALL) -> dict:
        self.send(json.dumps({"id": id_, "path": str(path), "aspects": aspects}))
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


def ready_entry(a):
    return {k: a[k] for k in ("aspect", "model", "kind", "dim")}


def test_ready_lists_aspects_from_manifest(worker):
    ready = worker.read()
    assert ready["ready"] is True
    assert ready["protocol"] == 2
    assert ready["aspects"] == [ready_entry(a) for a in ASPECTS]


@pytest.mark.parametrize("names", [["composition"], ["content", "pose"]])
def test_ready_lists_only_started_aspects(model_dir, names):
    w = Worker(model_dir, names)
    try:
        ready = w.read()
        assert ready["ready"] is True
        assert ready["aspects"] == [
            ready_entry(a) for a in ASPECTS if a["aspect"] in names
        ]
    finally:
        w.proc.kill()
        w.proc.wait()


def test_starts_without_files_of_aspects_not_started(tmp_path):
    d = write_models(tmp_path / "models")
    for f in POSE["files"]:
        (d / f["name"]).unlink()
    w = Worker(d, ["content", "composition"])
    try:
        assert w.read()["ready"] is True
        assert w.ask(1, write_image(tmp_path / "a.jpg", 1), ["content"])["ok"] is True
    finally:
        w.proc.kill()
        w.proc.wait()


@pytest.mark.parametrize("missing", [0, 1])
def test_missing_file_of_started_aspect_reports_not_ready(tmp_path, missing):
    d = write_models(tmp_path / "models")
    (d / POSE["files"][missing]["name"]).unlink()
    w = Worker(d, ["pose"])
    ready = w.read()
    assert ready["ready"] is False and ready["error"]
    assert w.proc.wait(timeout=30) == 1


def test_unknown_aspect_name_reports_not_ready(model_dir):
    w = Worker(model_dir, ["content", "colour"])
    ready = w.read()
    assert ready["ready"] is False and ready["error"]
    assert w.proc.wait(timeout=30) == 1


def test_returns_unit_vector_of_dim_per_aspect(worker, tmp_path):
    worker.read()
    res = worker.ask(1, write_image(tmp_path / "a.jpg", 1))
    assert res["id"] == 1 and res["ok"] is True
    for a in ASPECTS:
        if a["kind"] != "vector":
            continue
        v = np.array(res["features"][a["aspect"]])
        assert v.shape == (a["dim"],)
        assert np.isfinite(v).all()
        assert math.isclose(np.linalg.norm(v), 1.0, abs_tol=1e-5)


def test_3a_aspects_keep_values_from_before_pose(worker, tmp_path):
    # 3a のワーカー（protocol 1）で同じ偽のモデルと画像から出した値
    worker.read()
    f = worker.ask(1, write_image(tmp_path / "a.jpg", 1), ["content", "composition"])[
        "features"
    ]
    assert np.allclose(
        f["content"][:4], [-0.017816, 0.032943, -0.025789, -0.033662], atol=1e-5
    )
    assert math.isclose(sum(f["content"]), -1.29866, abs_tol=1e-4)
    assert np.allclose(
        f["composition"][:4], [0.045854, -0.034685, -0.074955, 0.005584], atol=1e-5
    )
    assert math.isclose(sum(f["composition"]), 7.945388, abs_tol=1e-4)


@pytest.mark.parametrize("names", [["pose"], ["content"], ["composition", "pose"]])
def test_returns_only_requested_aspects(worker, tmp_path, names):
    worker.read()
    res = worker.ask(1, write_image(tmp_path / "a.jpg", 1), names)
    assert res["ok"] is True and sorted(res["features"]) == sorted(names)


def test_pose_only_request_does_not_run_vector_models(model_dir, tmp_path, monkeypatch):
    calls = []
    run = ort.InferenceSession.run

    def counted(self, *args, **kwargs):
        calls.append(self.get_inputs()[0].name)
        return run(self, *args, **kwargs)

    monkeypatch.setattr(ort.InferenceSession, "run", counted)
    aspects = kura_worker.start(MANIFEST, model_dir, ALL)
    img = kura_worker.load(write_halves(tmp_path / "a.png"))
    assert set(kura_worker.compute(aspects, img, ["pose"])) == {"pose"}
    # 人物の検出と骨格の2つ（どちらも入力の名前は input）。内容のモデル（pixel_values）は呼ばない
    assert calls == ["input", "input"]


@pytest.mark.parametrize(
    "req",
    [
        {"id": 1, "path": "a.jpg"},
        {"id": 1, "path": "a.jpg", "aspects": []},
        {"id": 1, "path": "a.jpg", "aspects": "pose"},
        {"id": 1, "path": "a.jpg", "aspects": ["colour"]},
    ],
)
def test_exits_one_on_bad_aspects_in_request(worker, req):
    worker.read()
    worker.send(json.dumps(req))
    assert worker.proc.wait(timeout=30) == 1


def test_exits_one_when_request_asks_aspect_not_started(model_dir):
    w = Worker(model_dir, ["content", "composition"])
    w.read()
    w.send(json.dumps({"id": 1, "path": "a.jpg", "aspects": ["pose"]}))
    assert w.proc.wait(timeout=30) == 1


def ask_pose(tmp_path, dets, image, channels=None) -> dict:
    w = Worker(write_models(tmp_path / "models", dets, channels), ["pose"])
    try:
        w.read()
        res = w.ask(1, image, ["pose"])
        assert res["ok"] is True
        return res["features"]["pose"]
    finally:
        w.proc.kill()
        w.proc.wait()


def test_pose_none_when_no_person_box(tmp_path):
    assert ask_pose(tmp_path, [], write_halves(tmp_path / "a.png")) == {
        "status": "none",
        "people": [],
    }


def test_pose_few_when_no_person_has_enough_joints(tmp_path):
    # 黒い右半分の人物は、どの関節のスコアも0以下
    pose = ask_pose(
        tmp_path, [(200, 30, 260, 200, 0.9)], write_halves(tmp_path / "a.png")
    )
    assert pose == {"status": "few", "people": []}


def test_pose_ok_has_people_of_dim_finite_numbers(tmp_path):
    pose = ask_pose(
        tmp_path, [(40, 30, 100, 200, 0.9)], write_halves(tmp_path / "a.png")
    )
    assert pose["status"] == "ok" and len(pose["people"]) == 1
    person = np.array(pose["people"][0])
    assert person.shape == (POSE["dim"],) and np.isfinite(person).all()


def test_pose_keeps_only_people_with_enough_joints(tmp_path):
    pose = ask_pose(
        tmp_path,
        [(40, 30, 100, 200, 0.9), (200, 30, 260, 200, 0.9), (30, 20, 120, 220, 0.8)],
        write_halves(tmp_path / "a.png"),
    )
    assert pose["status"] == "ok" and len(pose["people"]) == 2


def test_pose_model_gets_rgb_channel_order(tmp_path):
    # 配布物の pipeline.json は to_rgb: true。赤い画像は入力の最初のチャンネルが明るい
    path = tmp_path / "red.png"
    Image.new("RGB", (320, 240), (255, 0, 0)).save(path)
    pose = ask_pose(tmp_path, [(40, 30, 100, 200, 0.9)], path, channels=(1, 0, 0))
    assert pose["status"] == "ok"


def test_pose_ignores_boxes_below_score_threshold(tmp_path):
    pose = ask_pose(
        tmp_path, [(40, 30, 100, 200, 0.01)], write_halves(tmp_path / "a.png")
    )
    assert pose == {"status": "none", "people": []}


def test_pose_coordinates_are_divided_by_long_side(tmp_path):
    # 偽の骨格のモデルは17点とも枠の中心に置く。中心 (70, 115) を長い辺 320 で割る
    pose = ask_pose(
        tmp_path, [(40, 30, 100, 200, 0.9)], write_halves(tmp_path / "a.png")
    )
    joints = np.array(pose["people"][0]).reshape(17, 3)
    assert np.allclose(joints[:, 0], 70 / 320, atol=1e-3)
    assert np.allclose(joints[:, 1], 115 / 320, atol=1e-3)
    assert (joints[:, 2] > 0.3).all()


def test_composition_dot_is_mean_of_gray_and_edge_cosines(worker, tmp_path):
    worker.read()
    paths = [write_image(tmp_path / f"{i}.png", i) for i in (1, 2)]
    a, b = (
        np.array(worker.ask(i, p, ["composition"])["features"]["composition"])
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
