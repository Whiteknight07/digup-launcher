#!/bin/bash
# Install a built extension using Tinycast's documented on-disk extension layout.
# --content-root DIR sets DigUp's content scope. --replace-file-search disables the built-in
# command and adds the "files" alias. --restart reloads Tinycast and starts DigUp's indexer.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
CONTENT_ROOT=""
REPLACE=0
RESTART=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --content-root)
      [[ $# -ge 2 && -d "$2" ]] || { echo '--content-root requires an existing folder.' >&2; exit 1; }
      CONTENT_ROOT="$2"; shift 2 ;;
    --replace-file-search) REPLACE=1; shift ;;
    --restart) RESTART=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
SOURCE="$PWD/release/digup"
if [[ "$RESTART" == 1 && -n "$CONTENT_ROOT" ]] && /usr/bin/pgrep -x DigUp >/dev/null; then
  echo 'Quit DigUp before changing its content folders with this installer.' >&2; exit 1
fi
DESTINATION="$HOME/Library/Application Support/com.tinycast.app/extensions/digup"
[[ -f "$SOURCE/search-files.js" && -x "$SOURCE/assets/digup-bridge" ]] || {
  echo "Run npm run package first." >&2; exit 1;
}
[[ -d /Applications/Tinycast.app ]] || { echo "Tinycast is not installed in /Applications." >&2; exit 1; }
mkdir -p "$(dirname "$DESTINATION")"
ditto "$SOURCE" "$DESTINATION"

# Reuse the model downloaded while developing, when available. Fresh installs let DigUp download it.
MODELS="$HOME/Library/Application Support/DigUp/Models"
for MODEL in embeddinggemma-2-Q8_0.gguf mmproj-embeddinggemma-2-Q8_0.gguf; do
  if [[ -f "$ROOT/.dev/models/$MODEL" && ! -f "$MODELS/$MODEL" ]]; then
    case "$MODEL" in
      embeddinggemma-2-Q8_0.gguf) HASH=2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135 ;;
      *) HASH=c4a8a52691ecef40618438928bdf9e68379b854e24166f292592353db0aab64f ;;
    esac
    [[ "$(shasum -a 256 "$ROOT/.dev/models/$MODEL" | cut -d ' ' -f 1)" == "$HASH" ]] || {
      echo "Model checksum failed: $MODEL" >&2; exit 1;
    }
    mkdir -p "$MODELS"
    cp "$ROOT/.dev/models/$MODEL" "$MODELS/$MODEL.partial"
    mv "$MODELS/$MODEL.partial" "$MODELS/$MODEL"
  fi
done
if [[ -n "$CONTENT_ROOT" ]]; then
  [[ -d "$CONTENT_ROOT" ]] || { echo "Content search folder does not exist." >&2; exit 1; }
  /usr/bin/defaults write com.abdurrahim.DigUp roots -array "$CONTENT_ROOT"
  /usr/bin/defaults write com.abdurrahim.DigUp onboarded -bool true
fi
if [[ "$REPLACE" == 1 ]]; then
  /usr/bin/defaults write com.tinycast.app launcherAliases -dict-add 'extension:digup/search-files' files
  /usr/bin/defaults write com.tinycast.app fileSearchEnabled -bool false
fi
if [[ "$RESTART" == 1 ]]; then
  /usr/bin/osascript -e 'tell application id "com.tinycast.app" to quit'
  REOPENED=0
  for ATTEMPT in {1..10}; do
    if /usr/bin/open -a /Applications/Tinycast.app 2>/dev/null; then REOPENED=1; break; fi
    sleep 0.5
  done
  [[ "$REOPENED" == 1 ]] || { echo "Installed, but Tinycast could not restart. Open it from Applications." >&2; exit 1; }
  /usr/bin/open "$DESTINATION/assets/DigUp.app"
fi
echo "Installed: $DESTINATION"
echo 'Run Search Files with DigUp in Tinycast. Restart Tinycast if it was already running.'
