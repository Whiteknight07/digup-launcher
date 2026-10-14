#!/bin/bash
# Fetch the pinned engine, apply our launcher integration and build a self-contained extension.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
  echo "Native content search requires an Apple Silicon Mac." >&2; exit 1;
}
REVISION=$(node -p "require('./native/upstream.json').revision")
REPOSITORY=$(node -p "require('./native/upstream.json').repository")
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid pinned DigUp revision.' >&2; exit 1; }
mkdir -p .native assets
SOURCE="$ROOT/.native/digup"
if [[ ! -d "$SOURCE/.git" ]]; then
  git clone --quiet --no-checkout --filter=blob:none "$REPOSITORY" "$SOURCE"
  git -C "$SOURCE" fetch --quiet --depth 1 origin "$REVISION"
  git -C "$SOURCE" checkout --quiet --detach "$REVISION"
fi
[[ "$(git -C "$SOURCE" rev-parse HEAD)" == "$REVISION" ]] || {
  echo 'Cached DigUp revision changed. Move .native/digup aside and rebuild.' >&2; exit 1;
}
PATCH="$ROOT/native/digup-launcher.patch"
if git -C "$SOURCE" apply --reverse --check "$PATCH" 2>/dev/null; then
  : # This exact patch is already applied.
else
  git -C "$SOURCE" apply --check "$PATCH"
  git -C "$SOURCE" apply "$PATCH"
fi
export CLANG_MODULE_CACHE_PATH="$ROOT/.native/module-cache"
export SWIFT_MODULECACHE_PATH="$ROOT/.native/module-cache"
mkdir -p "$CLANG_MODULE_CACHE_PATH"
bash scripts/build-bridge.sh
(cd "$SOURCE" && ./build.sh)
rm -rf "$ROOT/assets/DigUp.app"
ditto "$SOURCE/build.noindex/DigUp.app" "$ROOT/assets/DigUp.app"
/usr/libexec/PlistBuddy -c 'Add :DigUpLauncherBundle bool true' assets/DigUp.app/Contents/Info.plist
codesign --force --sign - --options runtime --preserve-metadata=entitlements assets/DigUp.app
cp "$SOURCE/LICENSE" assets/LICENSE.DigUp.txt
cp LICENSE assets/LICENSE.digup-launcher.txt
cp NOTICE assets/NOTICE.txt
lipo -archs assets/DigUp.app/Contents/Helpers/digup | grep -q arm64
codesign --verify --deep --strict assets/DigUp.app
echo "Native helpers built from DigUp $REVISION."
