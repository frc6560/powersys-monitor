#!/bin/bash
# Charging Champions - Live Power Monitor (macOS launcher).
# Double-click this. It serves this folder over http and opens the live dashboard.
cd "$(dirname "$0")" || exit 1
PORT=8100
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SRV=$!
sleep 1
open "http://localhost:$PORT/live.html"
echo "Live dashboard opened at http://localhost:$PORT/live.html"
echo "Enter your roboRIO address (e.g. 10.65.60.2) and click Connect."
echo "Press Ctrl+C or close this window to stop the server."
trap "kill $SRV 2>/dev/null" EXIT
wait $SRV
