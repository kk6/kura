#!/usr/bin/env bash
# ボードの保存の待ち行列のモデル（BoardSaveQueue.tla）を TLC で検査する。使い方は SKILL.md
#   check.sh            ずれの確認 → 今のコードのモデル → 壊した版がそれぞれ落ちること
#   check.sh model      今のコードのモデルだけ
#   check.sh drift      ずれの確認だけ
#   check.sh rehash     coverage.tsv の指紋を今のコードで書き直す（モデルを確かめた後だけ）
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JAR="${TLA2TOOLS:-$REPO/.claude/tmp/tla/tla2tools-$TLA_VERSION.jar}"
OUT="$REPO/.claude/tmp/tla/out/board-save"

# ファイル全体の指紋。待ち行列は1つのファイルに収まるので、関数ごとに分けない
fingerprint() { tr -d '[:space:]' <"$REPO/$1" | shasum -a 256 | cut -c1-16; }

drift() {
  local changed=0 file want got
  while IFS=$'\t' read -r file want; do
    [[ -z "$file" || "$file" == \#* ]] && continue
    got=$(fingerprint "$file")
    if [[ "$got" != "$want" ]]; then
      echo "DRIFT  $file ($want -> $got)"; changed=1
    fi
  done <"$HERE/coverage.tsv"
  [[ $changed == 0 ]] && echo "ok     covered code matches coverage.tsv"
  return $changed
}

rehash() {
  local tmp; tmp=$(mktemp)
  while IFS= read -r line; do
    if [[ -z "$line" || "$line" == \#* ]]; then printf '%s\n' "$line" >>"$tmp"; continue; fi
    IFS=$'\t' read -r file want <<<"$line"
    printf '%s\t%s\n' "$file" "$(fingerprint "$file")" >>"$tmp"
  done <"$HERE/coverage.tsv"
  mv "$tmp" "$HERE/coverage.tsv"
  echo "rewrote coverage.tsv. Now set the sync commit in SKILL.md."
}

need_jar() {
  [[ -f "$JAR" ]] || { echo "error: $JAR がない。verify-crash-safe-move の SKILL.md の「準備」を見る" >&2; exit 2; }
  [[ "$(shasum -a 256 "$JAR" | cut -d' ' -f1)" == "$TLA_SHA256" ]] || { echo "error: $JAR の sha256 が $TLA_SHA256 と違う" >&2; exit 2; }
}

# tlc <cfg> : 出力を $OUT/<名前>.txt に残し、結果の行を返す
tlc() {
  local cfg=$1 name; name=$(basename "$cfg" .cfg)
  mkdir -p "$OUT"
  (cd "$HERE" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers auto \
      -metadir "$OUT/states-$name" -config "$cfg" BoardSaveQueue.tla) >"$OUT/$name.txt" 2>&1
  rm -rf "$OUT/states-$name"
  grep -E "^Error: (Invariant|Temporal properties)|is violated|Model checking completed. No error|distinct states found" "$OUT/$name.txt" | head -3
}

model() {
  need_jar
  local res; res=$(tlc MC.cfg)
  echo "$res" | sed 's/^/       /'
  if grep -q "No error" <<<"$res"; then echo "PASS   MC.cfg (the code as it is)"; return 0; fi
  echo "FAIL   MC.cfg -- read $OUT/MC.txt with /statechart"; return 1
}

mutants() {
  need_jar
  local bad=0 cfg want res
  for cfg in "$HERE"/mutants/*.cfg; do
    want=$(grep -oE "Expect [A-Za-z]+" "$cfg" | cut -d' ' -f2)
    res=$(tlc "mutants/$(basename "$cfg")")
    if grep -q "$want" <<<"$res"; then
      echo "ok     $(basename "$cfg") fails $want as expected"
    else
      echo "FAIL   $(basename "$cfg") should fail $want but got: $res"; bad=1
    fi
  done
  return $bad
}

case "${1:-all}" in
  drift) drift ;;
  rehash) rehash ;;
  model) model ;;
  all)
    d=0; drift || d=1
    model; m=$?
    mutants; u=$?
    [[ $d == 1 ]] && echo "NOTE   covered code changed since the sync commit: re-read it against the model (SKILL.md)"
    exit $(( m || u || d ))
    ;;
  *) sed -n 2,7p "$0"; exit 2 ;;
esac
