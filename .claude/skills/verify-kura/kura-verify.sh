#!/usr/bin/env bash
# Kura の実アプリを検証用に隔離して起動・確認・停止する。使い方は同じフォルダの SKILL.md
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE="$REPO/.claude/tmp/verify-kura"
# KURA_BUILD=release でリリース用ビルド（npm run tauri build）の .app を同じ隔離で使う。性能の確認用
BUILD="${KURA_BUILD:-debug}"
[[ "$BUILD" == debug || "$BUILD" == release ]] || { echo "error: KURA_BUILD は debug か release" >&2; exit 1; }
APP="$REPO/src-tauri/target/$BUILD/bundle/macos/Kura.app"
BIN="$APP/Contents/MacOS/kura"
REAL_DATA="$HOME/Library/Application Support/dev.kk6.kura"
# net up のプロキシの待ち受け。検証用の Kura は同時に1つだけなので固定にする
PROXY_PORT=18080

die() { echo "error: $*" >&2; exit 1; }
# run id は runs/ の直下の1つの名前に限る。stop が run の中を rm -rf するので、../ などで外を指させない
valid_id() { [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; }
run_dir() { valid_id "${1:-}" || die "run id は英数字と . _ - だけ（'${1:-}'）"; echo "$BASE/runs/$1"; }
# 偽の HOME の中のアプリのデータフォルダ（recent-libraries.json と settings.json の置き場所）。デバッグビルドは debug/ の下を使う
# リリース用ビルドは debug/ を付けない
data_dir() { echo "$(run_dir "$1")/home/Library/Application Support/dev.kk6.kura$([ "$BUILD" = debug ] && echo /debug)"; }
# pid ファイルは「pid<TAB>起動時刻」。pid が別のプロセスに使い回されても、起動時刻が違えば自分のものと見なさない
pid_of() { cut -f1 "$(run_dir "$1")/pid" 2>/dev/null || true; }
started_of() { cut -f2 "$(run_dir "$1")/pid" 2>/dev/null || true; }
started() { ps -o lstart= -p "$1" 2>/dev/null || true; }
# 環境変数の値に空白があっても比べられるよう、期待する並び全体を固定文字列で探す
has_home() { [[ " $(ps eww -o command= -p "$1" 2>/dev/null) " == *" HOME=$2 "* ]]; }
# 自分が起動した、この run の Kura か：pid が生きていて、起動時刻、実行ファイル、HOME がすべて合う
ours() {
  local p; p=$(pid_of "$1")
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null \
    && [ "$(started "$p")" = "$(started_of "$1")" ] \
    && [[ "$(ps -o command= -p "$p")" == "$BIN"* ]] \
    && has_home "$p" "$(run_dir "$1")/home"
}

cmd_build() {
  if [ "$BUILD" = release ]; then
    cd "$REPO" && npm run tauri build -- --bundles app
  else
    cd "$REPO" && npm run tauri build -- --debug --bundles app
  fi
}

# launch <id> [empty|template|<library>]
#   empty    : ライブラリなし。選択画面から始まる（作る・開くの検証用）
#   template : 取り込み済みの見本（$BASE/template）を run の lib/ に複製して開く（既定）
#   <path>   : この手順で作ったライブラリ（.kura/ を持つフォルダ）を run の lib/ に複製して開く。本物の資料フォルダは渡さない
#              KURA_IN_PLACE=1 なら複製せずにその場で開く（$BASE の下にマウントしたディスクイメージの確認用）。
#              KURA_ALSO=<path> で、2つ目のライブラリを「最近使ったライブラリ」に足す（同じく $BASE の下だけ）
cmd_launch() {
  local id=$1 mode=${2:-template} dir
  dir=$(run_dir "$id")
  [ -x "$BIN" ] || die "$APP がない。先に: $0 build"
  pgrep -f "$BIN" >/dev/null && die "別の検証用 Kura が動いている（pgrep -fl '$BIN'）。先に stop する"
  # 途中で失敗した run の lib/ が残っていると、cp -R がその中へ複製して古い DB を開くので、フォルダごと使用済みとみなす
  [ -e "$dir" ] && die "$dir は使用済み。別の run id を使う"
  # 複製元は、この手順で作ったもの（$BASE の下）に限る。本物の資料のライブラリを渡されても読まない
  local src_lib=""
  if [ "$mode" != empty ] && [ "$mode" != template ]; then
    local base_real
    src_lib=$(cd "$mode" 2>/dev/null && pwd -P) || die "$mode がない"
    base_real=$(cd "$BASE" && pwd -P) || die "$BASE がない"
    [[ "$src_lib/" == "$base_real/"* ]] || die "$mode は $BASE の下にない。この手順で作ったライブラリだけを渡す"
    [ -d "$src_lib/.kura" ] || die "$mode はライブラリではない"
  fi
  mkdir -p "$dir/home" "$dir/evidence" "$(data_dir "$id")"
  local lib=""
  case $mode in
    empty) mkdir -p "$dir/lib" ;;
    template)
      [ -d "$BASE/template/.kura" ] || die "見本のライブラリがない。SKILL.md の「見本を作る」を先に行う"
      cp -R "$BASE/template" "$dir/lib"; lib="$dir/lib" ;;
    *)
      # その場で開くときも、db と ls が run の lib/ で引けるようにリンクを置く。stop はリンクだけを消す
      if [ "${KURA_IN_PLACE:-}" = 1 ]; then lib="$src_lib"; ln -s "$src_lib" "$dir/lib"; else cp -R "$src_lib" "$dir/lib"; lib="$dir/lib"; fi ;;
  esac
  local also=""
  if [ -n "${KURA_ALSO:-}" ]; then
    also=$(cd "$KURA_ALSO" 2>/dev/null && pwd -P) || die "$KURA_ALSO がない"
    [[ "$also/" == "$(cd "$BASE" && pwd -P)/"* ]] || die "$KURA_ALSO は $BASE の下にない"
    [ -d "$also/.kura" ] || die "$KURA_ALSO はライブラリではない"
  fi
  [ -n "$lib" ] && restore_dirs "$lib"
  # 起動時、アプリは一覧の先頭のライブラリを自動で開く。空なら選択画面
  python3 -I -c 'import json, sys; print(json.dumps(sys.argv[1:]))' ${lib:+"$lib"} ${also:+"$also"} >"$(data_dir "$id")/recent-libraries.json"
  start_app "$id" "$lib"
  ours "$id" || { cat "$dir/app.log"; die "起動直後に終了した"; }
  echo "pid=$(pid_of "$id") run=$dir lib=${lib:-なし}"
  cmd_doctor "$id"
}

# ワークツリーに写した .claude/tmp は空のフォルダを落とすので、見本の _未分類 と空のカテゴリが消えていることがある。
# _未分類 がないと取り込みが「フォルダを読めません」で失敗するので、DB のカテゴリの道筋からフォルダを作り直す
restore_dirs() {
  mkdir -p "$1/_未分類"
  [ -f "$1/.kura/kura.db" ] || return 0
  sqlite3 -readonly "$1/.kura/kura.db" "with recursive p(id, path) as (
      select id, name from categories where parent_id is null
      union all select c.id, p.path || '/' || c.name from categories c join p on c.parent_id = p.id)
    select path from p" | while IFS= read -r d; do mkdir -p "$1/$d"; done
}

# start_app <id> <lib> : run の HOME で Kura を起動し、ライブラリを開くまで待つ。app.log には書き足す
start_app() {
  local id=$1 lib=$2 dir; dir=$(run_dir "$1")
  local opened; opened=$(grep -c "ライブラリを開きました\|ライブラリが見つかりません" "$dir/app.log" 2>/dev/null || true)
  # HOME を差し替えて、利用者の ~/Library/Application Support/dev.kk6.kura を読まない・書かない
  # KURA_PROXY=1 なら、curl（モデルのダウンロード）を net up のプロキシに通す。net up の前は通信できない
  local proxy=()
  [ "${KURA_PROXY:-}" = 1 ] && proxy=(HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" HTTP_PROXY="http://127.0.0.1:$PROXY_PORT")
  env HOME="$dir/home" RUST_LOG=info ${proxy[@]+"${proxy[@]}"} nohup "$BIN" >>"$dir/app.log" 2>&1 &
  local p=$!
  sleep 0.2
  printf '%s\t%s\n' "$p" "$(started "$p")" >"$dir/pid"
  for _ in $(seq 1 40); do
    [ "$(grep -c "ライブラリを開きました\|ライブラリが見つかりません" "$dir/app.log")" -gt "${opened:-0}" ] && break
    [ -z "$lib" ] && sleep 2 && break
    sleep 0.5
  done
}

# relaunch <id> : 同じ run の HOME とライブラリのまま、Kura を起動し直す（再起動の後に設定や計算が残るかの確認）。
# 動いていれば止めてから起動する。終了の確認なら、先に画面で ⌘Q してから流す
cmd_relaunch() {
  local dir; dir=$(run_dir "$1")
  [ -d "$dir/home" ] || die "$dir は起動していない。先に launch"
  kill_app "$1"
  pgrep -f "$BIN" >/dev/null && die "別の検証用 Kura が動いている（pgrep -fl '$BIN'）"
  start_app "$1" "$([ -e "$dir/lib/.kura" ] && echo "$dir/lib")"
  ours "$1" || { tail -20 "$dir/app.log"; die "起動直後に終了した"; }
  cmd_doctor "$1"
}

cmd_doctor() {
  local id=$1 dir ok=1
  dir=$(run_dir "$id")
  local p; p=$(pid_of "$id")
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null && [ "$(started "$p")" = "$(started_of "$id")" ] \
    && echo "ok   process $p alive (started $(started_of "$id"))" || { echo "FAIL process not running, or pid reused"; ok=0; }
  has_home "$p" "$dir/home" && echo "ok   HOME=$dir/home" || { echo "FAIL HOME is not $dir/home"; ok=0; }
  local n; n=$(pgrep -f "$BIN" | wc -l | tr -d ' ')
  [ "$n" = 1 ] && echo "ok   one verification Kura running" || { echo "FAIL $n verification Kura processes"; ok=0; }
  find "$REPO/src" "$REPO/src-tauri/src" -newer "$BIN" -type f | grep -q . \
    && echo "warn sources changed after the last build (rebuild: $0 build)" || echo "ok   build is newer than src/ and src-tauri/src/"
  echo "--- recent-libraries.json"; cat "$(data_dir "$id")/recent-libraries.json" 2>/dev/null && echo || echo "(none)"
  echo "--- app.log (tail)"; tail -5 "$dir/app.log" 2>/dev/null || true
  [ $ok = 1 ]
}

# db <id> <sql> [features] : run の lib/ の DB（features なら類似画像検索の features.db）を読み取り専用で見る
# Kura は DB を排他モードで開くので、動いている間はほかのプロセスが開けない。DB と WAL を写して、写しを読む。
# 書き込みの途中に写すと半端な写しになることがあるので、操作の後に少し待ってから使う
cmd_db() {
  local db copy name="${3:-kura}"; db="$(run_dir "$1")/lib/.kura/$name.db"
  [ -f "$db" ] || die "$db がない"
  copy=$(mktemp -d "${TMPDIR:-/tmp}/kura-db.XXXXXX")
  cp "$db" "$copy/$name.db"
  [ -f "$db-wal" ] && cp "$db-wal" "$copy/$name.db-wal"
  sqlite3 -header "$copy/$name.db" "$2"
  rm -rf "$copy"
}

# stop <id> : 自分が起動した pid だけを止める。evidence/ は残し、ほかは消す
kill_app() {
  local p; p=$(pid_of "$1")
  if ours "$1"; then
    kill "$p"; for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p"
  fi
  # この run の HOME で動いている Kura が残っていれば（自分のものと確かめられなかったものを含む）、
  # その run のデータを消したり複製したりしない
  local q
  for q in $(pgrep -f "$BIN" || true); do
    has_home "$q" "$(run_dir "$1")/home" && die "pid $q がこの run のデータで動いている。止めて確かめるまで後片付けしない"
  done
  return 0
}

# template <id> : アプリを止め、run の lib/ を見本（$BASE/template）として保存する。古い見本は置き換える
cmd_template() {
  local dir; dir=$(run_dir "$1")
  [ -d "$dir/lib/.kura" ] || die "$dir/lib はライブラリではない"
  kill_app "$1"
  rm -rf "$BASE/template" && cp -R "$dir/lib" "$BASE/template"
  echo "saved template: $BASE/template ($(sqlite3 -readonly "$BASE/template/.kura/kura.db" 'select count(*) from images') images)"
}

cmd_stop() {
  local id=$1 dir
  dir=$(run_dir "$id")
  kill_app "$id"
  proxy_down "$id"
  [ -f "$dir/app.log" ] && cp "$dir/app.log" "$dir/evidence/app.log"
  rm -rf "$dir/home" "$dir/lib" "$dir/src" "$dir/pid" "$dir/app.log"
  echo "stopped. evidence: $dir/evidence"
  ls "$dir/evidence"
}

# src <id> [枚数] : 取り込み元のダミー画像フォルダを run の src/ に作る
cmd_src() {
  local dir; dir=$(run_dir "$1")
  mkdir -p "$dir"
  cd "$REPO" && uv run scripts/gen_dev_library.py "${2:-30}" --out "$dir/src"
}

# windows <id> : 自分が起動した Kura のウィンドウの名前、層（最前面の固定で 0 以外）、不透明度、位置と大きさ
# 画面ではなく WindowServer の値なので、最前面の固定と不透明度の証跡になる（FR-705、FR-707）
cmd_windows() {
  ours "$1" || die "この run の Kura が動いていない"
  local f; f=$(mktemp "${TMPDIR:-/tmp}/kura-windows.XXXXXX").swift
  cat >"$f" <<'SWIFT'
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  guard let name = w[kCGWindowName as String] as? String, !name.isEmpty else { continue }
  let b = w[kCGWindowBounds as String] as! [String: Any]
  print("\(name)\tlayer=\(w[kCGWindowLayer as String]!)\talpha=\(w[kCGWindowAlpha as String]!)\tonscreen=\(w[kCGWindowIsOnscreen as String] ?? 0)\tx=\(b["X"]!) y=\(b["Y"]!) w=\(b["Width"]!) h=\(b["Height"]!)")
}
SWIFT
  swift "$f" "$(pid_of "$1")"
  rm -f "$f"
}

# model <id> : 内容（SigLIP 2）のモデルを、run のアプリのデータフォルダの models/ に置く（ダウンロードの代わり）。
# ポーズのモデルは置かない。3a から更新した利用者と同じく、ポーズのモデルだけがない状態になる。
# 複製元は KURA_MODEL_SRC（既定は本体のリポジトリの spikes/similarity/models/siglip2-b16.onnx。git の管理外）。
# ml/model.json の名前で置き、SHA-256 が合うことを確かめる。ON にするとアプリは通信せずにこれを使う
cmd_model() {
  local dir; dir=$(run_dir "$1")
  [ -d "$dir/home" ] || die "$dir は起動していない。先に launch"
  local main; main=$(cd "$(git -C "$REPO" rev-parse --git-common-dir)/.." && pwd)
  local src="${KURA_MODEL_SRC:-$main/spikes/similarity/models/siglip2-b16.onnx}"
  [ -f "$src" ] || die "$src がない。KURA_MODEL_SRC にモデルのファイルを渡す"
  local name sha
  read -r name sha < <(python3 -I -c 'import json, sys
for a in json.load(open(sys.argv[1]))["aspects"]:
    if a["aspect"] == "content": print(a["files"][0]["name"], a["files"][0]["sha256"])' "$REPO/ml/model.json")
  local models; models="$(data_dir "$1")/models"
  mkdir -p "$models"
  # APFS なら複製（cp -c）で、372MB を写さずに済む
  cp -c "$src" "$models/$name.copy" 2>/dev/null || cp "$src" "$models/$name.copy"
  [ "$(shasum -a 256 "$models/$name.copy" | cut -d' ' -f1)" = "$sha" ] || { rm -f "$models/$name.copy"; die "$src の SHA-256 が ml/model.json と違う"; }
  mv "$models/$name.copy" "$models/$name"
  echo "placed: $models/$name (sha256 ok)"
}

# net <id> up|down : KURA_PROXY=1 で起動した Kura の通信の口を開ける・閉じる。
# down はプロキシを止めるので、ダウンロードの途中なら通信が切れる。記録は evidence/proxy.log
proxy_pid() { cat "$(run_dir "$1")/proxy.pid" 2>/dev/null || true; }
proxy_down() {
  local p; p=$(proxy_pid "$1")
  # pid が使い回されていても、このプロキシでなければ止めない
  [ -n "$p" ] && [[ "$(ps -o command= -p "$p" 2>/dev/null)" == *verify-kura/proxy.py* ]] && kill "$p"
  rm -f "$(run_dir "$1")/proxy.pid"
}
cmd_net() {
  local dir; dir=$(run_dir "$1")
  case "${2:-}" in
    up)
      [ -n "$(proxy_pid "$1")" ] && die "もう up している"
      lsof -nP -iTCP:$PROXY_PORT -sTCP:LISTEN >/dev/null && die "ポート $PROXY_PORT を別のプロセスが使っている"
      mkdir -p "$dir/evidence"
      nohup python3 -I "$REPO/.claude/skills/verify-kura/proxy.py" $PROXY_PORT >>"$dir/evidence/proxy.log" 2>&1 &
      echo $! >"$dir/proxy.pid"
      sleep 0.3; tail -1 "$dir/evidence/proxy.log" ;;
    down) proxy_down "$1"; echo "down" ;;
    *) die "net <id> up|down" ;;
  esac
}

case "${1:-}" in
  build) cmd_build ;;
  launch|relaunch|doctor|db|stop|src|template|windows|model|net)
    c=$1; shift
    valid_id "${1:-}" || die "run id は英数字と . _ - だけ（'${1:-}'）"
    "cmd_$c" "$@" ;;
  real-data-mtime) stat -f '%m %N' "$REAL_DATA"/* 2>/dev/null || true ;;
  *) echo "usage: $0 build | launch <id> [empty|template|<lib>] | relaunch <id> | doctor <id> | src <id> [n] | db <id> <sql> | windows <id> | template <id> | model <id> | net <id> up|down | stop <id> | real-data-mtime"; exit 2 ;;
esac
