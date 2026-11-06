#!/usr/bin/env bash
# Kura の実アプリを検証用に隔離して起動・確認・停止する。使い方は同じフォルダの SKILL.md
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE="$REPO/.claude/tmp/verify-kura"
APP="$REPO/src-tauri/target/debug/bundle/macos/Kura.app"
BIN="$APP/Contents/MacOS/kura"
REAL_DATA="$HOME/Library/Application Support/dev.kk6.kura"

die() { echo "error: $*" >&2; exit 1; }
run_dir() { [ -n "${1:-}" ] || die "run id が要る"; echo "$BASE/runs/$1"; }
# 偽の HOME の中のアプリのデータフォルダ（recent-libraries.json と settings.json の置き場所）
data_dir() { echo "$(run_dir "$1")/home/Library/Application Support/dev.kk6.kura"; }
pid_of() { cat "$(run_dir "$1")/pid" 2>/dev/null || true; }
alive() { local p; p=$(pid_of "$1"); [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

cmd_build() {
  cd "$REPO" && npm run tauri build -- --debug --bundles app
}

# launch <id> [empty|template|<library>]
#   empty    : ライブラリなし。選択画面から始まる（作る・開くの検証用）
#   template : 取り込み済みの見本（$BASE/template）を run の lib/ に複製して開く（既定）
#   <path>   : 既存のライブラリ（.kura/ を持つフォルダ）を開く。本物の資料フォルダは渡さない
cmd_launch() {
  local id=$1 mode=${2:-template} dir
  dir=$(run_dir "$id")
  [ -x "$BIN" ] || die "$APP がない。先に: $0 build"
  pgrep -f "$BIN" >/dev/null && die "別の検証用 Kura が動いている（pgrep -fl '$BIN'）。先に stop する"
  [ -e "$dir/pid" ] && die "$dir は使用済み。別の run id を使う"
  mkdir -p "$dir/home" "$dir/evidence" "$(data_dir "$id")"
  local lib=""
  case $mode in
    empty) mkdir -p "$dir/lib" ;;
    template)
      [ -d "$BASE/template/.kura" ] || die "見本のライブラリがない。SKILL.md の「見本を作る」を先に行う"
      cp -R "$BASE/template" "$dir/lib"; lib="$dir/lib" ;;
    *) [ -d "$mode/.kura" ] || die "$mode はライブラリではない"; lib=$(cd "$mode" && pwd) ;;
  esac
  # 起動時、アプリは一覧の先頭のライブラリを自動で開く。空なら選択画面
  if [ -n "$lib" ]; then printf '["%s"]\n' "$lib" >"$(data_dir "$id")/recent-libraries.json"
  else echo '[]' >"$(data_dir "$id")/recent-libraries.json"; fi
  # HOME を差し替えて、利用者の ~/Library/Application Support/dev.kk6.kura を読まない・書かない
  HOME="$dir/home" RUST_LOG=info nohup "$BIN" >"$dir/app.log" 2>&1 &
  echo $! >"$dir/pid"
  for _ in $(seq 1 40); do
    grep -q "ライブラリを開きました\|ライブラリが見つかりません" "$dir/app.log" 2>/dev/null && break
    [ -z "$lib" ] && sleep 2 && break
    sleep 0.5
  done
  alive "$id" || { cat "$dir/app.log"; die "起動直後に終了した"; }
  echo "pid=$(pid_of "$id") run=$dir lib=${lib:-なし}"
  cmd_doctor "$id"
}

cmd_doctor() {
  local id=$1 dir ok=1
  dir=$(run_dir "$id")
  alive "$id" && echo "ok   process $(pid_of "$id") alive" || { echo "FAIL process not running"; ok=0; }
  local env_home
  env_home=$(ps eww -p "$(pid_of "$id")" 2>/dev/null | tr ' ' '\n' | grep '^HOME=' || true)
  [ "$env_home" = "HOME=$dir/home" ] && echo "ok   $env_home" || { echo "FAIL HOME is '$env_home'"; ok=0; }
  local n; n=$(pgrep -f "$BIN" | wc -l | tr -d ' ')
  [ "$n" = 1 ] && echo "ok   one verification Kura running" || { echo "FAIL $n verification Kura processes"; ok=0; }
  find "$REPO/src" "$REPO/src-tauri/src" -newer "$BIN" -type f | grep -q . \
    && echo "warn sources changed after the last build (rebuild: $0 build)" || echo "ok   build is newer than src/ and src-tauri/src/"
  echo "--- recent-libraries.json"; cat "$(data_dir "$id")/recent-libraries.json" 2>/dev/null && echo || echo "(none)"
  echo "--- app.log (tail)"; tail -5 "$dir/app.log" 2>/dev/null || true
  [ $ok = 1 ]
}

# db <id> <sql> : run の lib/ の DB を読み取り専用で見る
cmd_db() {
  local db; db="$(run_dir "$1")/lib/.kura/kura.db"
  [ -f "$db" ] || die "$db がない"
  sqlite3 -readonly -header "file:$db?mode=ro" "$2"
}

# stop <id> : 自分が起動した pid だけを止める。evidence/ は残し、ほかは消す
kill_app() {
  local p; p=$(pid_of "$1")
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    kill "$p"; for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p"
  fi
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

case "${1:-}" in
  build) cmd_build ;;
  launch|doctor|db|stop|src|template) c=$1; shift; "cmd_$c" "$@" ;;
  real-data-mtime) stat -f '%m %N' "$REAL_DATA"/* 2>/dev/null || true ;;
  *) echo "usage: $0 build | launch <id> [empty|template|<lib>] | doctor <id> | src <id> [n] | db <id> <sql> | template <id> | stop <id> | real-data-mtime"; exit 2 ;;
esac
