#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if pgrep -f '/KuraNativeSpike.app/Contents/MacOS/kura-board-native-spike$' >/dev/null; then
  echo 'A native spike is already running.' >&2
  exit 1
fi
run="$PWD/.claude/tmp/phase2-native/run-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$run/home" "$run/evidence"
cp src/styles/tokens.css spikes/board-native/ui/tokens.css
export CARGO_TARGET_DIR="$PWD/src-tauri/target"
cargo build --offline --manifest-path spikes/board-native/src-tauri/Cargo.toml
printf '%s\n' "$run"
bundle="$run/KuraNativeSpike.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$CARGO_TARGET_DIR/debug/kura-board-native-spike" "$bundle/Contents/MacOS/kura-board-native-spike"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>kura-board-native-spike</string>
<key>CFBundleIdentifier</key><string>dev.kk6.kura.native-spike</string>
<key>CFBundleName</key><string>Kura Native Spike</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
echo $$ > "$run/pid"
exec env HOME="$run/home" SPIKE_RUN_DIR="$run" "$bundle/Contents/MacOS/kura-board-native-spike" >"$run/process.log" 2>&1
