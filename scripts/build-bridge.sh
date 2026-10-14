#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets .native/module-cache
swiftc -swift-version 5 -target arm64-apple-macosx14.0 -O \
  -module-cache-path "$PWD/.native/module-cache" native/Bridge.swift -o assets/digup-bridge
codesign --force --sign - assets/digup-bridge
