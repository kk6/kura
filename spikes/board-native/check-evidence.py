"""Check recorded native observations without launching or controlling an app."""

import re
import sys
from pathlib import Path

base = Path(__file__).resolve().parents[2] / ".claude/tmp/phase2-native"
runs = [Path(argument).resolve() for argument in sys.argv[1:]]
assert len(runs) == 3, "pass the alpha, lifecycle, and quit-success run directories"
assert all(run.is_relative_to(base.resolve()) for run in runs), "only generated runs"
alpha, lifecycle, quit_success = runs
alpha_log, lifecycle_log, quit_log = [(run / "events.log").read_text() for run in runs]

for value in ["0.3", "0.65", "1"]:
    assert f"native alpha={value} ignoresMouseEvents=false" in alpha_log
for name in ["alpha30", "alpha65", "alpha100", "close-wait", "close-failed"]:
    assert (alpha / "evidence" / f"{name}.png").stat().st_size > 0
assert alpha_log.count("CloseRequested board") == 2
assert "ExitRequested" not in alpha_log, "baseline predefined Quit bypassed the hook"

for intent in ["Exit", "Off"]:
    assert re.search(
        rf"保存中 revision=1 intent={intent}\n保存できませんでした・遷移中止 revision=1",
        lifecycle_log,
    ), f"{intent} failure must cancel the transition"
for intent in ["Board", "Off", "Exit"]:
    assert f"保存済み revision=1 intent={intent}" in lifecycle_log
assert "CloseRequested main" in lifecycle_log
assert "ボードのみ終了・ギャラリーは継続" in lifecycle_log
assert "Menu save-quit\n保存中 revision=1 intent=Exit" in quit_log
assert "保存済み revision=1 intent=Exit\nExitRequested code=Some(0)" in quit_log
for run in [lifecycle, quit_success]:
    assert (run / "snapshot.txt").read_text() == "人工配置 revision=1\n"
    assert f"isolated HOME={run}/home" in (run / "events.log").read_text()

top_on = (lifecycle / "evidence/top-on.txt").read_text()
top_off = (lifecycle / "evidence/top-off.txt").read_text()
board_on = re.search(
    r"order=(\d+) owner=Kura Native Spike id=(\d+) alpha=1 layer=5 bounds=\{\n    Height = 500;",
    top_on,
)
calculator_on = re.search(
    r"order=(\d+) owner=計算機 id=(\d+) alpha=1 layer=0 bounds=\{\n    Height = 408;",
    top_on,
)
assert board_on and calculator_on
assert int(board_on[1]) < int(calculator_on[1]), "board stays above another app"
board_off = re.search(
    rf"order=(\d+) owner=Kura Native Spike id={board_on[2]} alpha=1 layer=0", top_off
)
calculator_off = re.search(
    rf"order=(\d+) owner=計算機 id={calculator_on[2]} alpha=1 layer=0", top_off
)
assert board_off and calculator_off
assert int(calculator_off[1]) < int(board_off[1]), "normal ordering restored"
print("PASS: alpha, native ordering, save cancellation, saved revisions, isolated HOME")
print(
    "Process exit and screenshot appearance require the recorded runtime/UI observations."
)
