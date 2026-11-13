#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required to run the NMEA viewer."
  echo "Install it from https://nodejs.org/ and try again."
  exit 1
fi
exec node server.mjs --open
