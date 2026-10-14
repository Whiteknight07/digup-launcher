#!/bin/bash
# Build the versioned, portable Tinycast import ZIP and its checksum.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run package
VERSION=$(node -p "require('./package.json').version")
ARCHIVE="digup-launcher-$VERSION-macos-arm64.zip"
mkdir -p artifacts
ditto -c -k --keepParent --norsrc release/digup "artifacts/$ARCHIVE"
(cd artifacts && shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256")
echo "Release: artifacts/$ARCHIVE"
