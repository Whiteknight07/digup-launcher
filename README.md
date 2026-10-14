# DigUp Launcher

Local file search inside **Tinycast**, built with the Raycast extension API.
Find a file or folder by name, or describe what's inside a document, image, recording or video.

**[Download the latest release](https://github.com/Whiteknight07/digup-launcher/releases/latest)** · Apple Silicon · MIT

This combines Spotlight's file and folder names with [DigUp](https://github.com/ARahim3/DigUp)'s local content search.
DigUp runs its model on your Mac and manages indexing. The extension supplies the launcher UI,
previews, filters, and open, reveal, Quick Look and clipboard actions.

Examples: `invoice 2026`, `the clause about pets in the lease`, `a dog on the beach`,
or `where they talk about sleep`. `code: retry with backoff` searches code when enabled in DigUp.

## Install in Tinycast

1. Download the `macos-arm64.zip` from [Releases](https://github.com/Whiteknight07/digup-launcher/releases).
2. Unzip it. In **Tinycast → Settings → Extensions**, enable extensions, then **Install → Add from folder** and choose the unzipped `digup` folder.
3. Run **Open DigUp Settings**. Choose the folders you want indexed. DigUp downloads its model once, about 865 MB, and begins indexing those folders.
4. Run **Search Files with DigUp**. Set a hotkey or an alias such as `files` in Tinycast's command configuration. To replace the built-in search, disable **Settings → File Search**.

**You don't need Node or Xcode to use the ZIP.** Filename search works immediately using Spotlight.
Content search fills in as the first index is built. Keep DigUp running for new files to be indexed;
you can enable its launch-at-login option in DigUp's settings.

If you already run DigUp from another location, quit that copy before opening the extension's bundled copy.
The bundled copy shares DigUp's settings, model files and index.

The native engine requires an Apple Silicon Mac with macOS 14 or later. Tinycast has its own
[system requirements](https://tinycast.dev/). This extension was tested in Tinycast 0.11.19.

### macOS download approval

The native helpers are ad-hoc signed, and the ZIP is **not notarized**. If macOS blocks a downloaded helper,
use [macOS's **Privacy & Security → Open Anyway** option](https://support.apple.com/en-us/102445) for software you trust, or build from source below.
macOS may also ask DigUp for access to the folders you choose and permission to control QuickTime Player.

### Raycast

The source uses Raycast's extension API and passes Raycast's build and TypeScript checks.
It has been tested in Tinycast's runtime; a full Raycast app test is still needed.
To try it in Raycast, build the native assets below, use **Import Extension** on this repository folder,
and run `npm run dev`. It isn't published to the Raycast Store.

## Search and actions

- Plain text searches filenames and content. Duplicate files appear once, with DigUp's content ranking preserved.
- `name: invoice` searches filenames only. `content: pets clause` searches content only. `code:` uses DigUp's separate code index.
- The type dropdown narrows candidates before searching. Folders and archives use Spotlight.
- **Enter** opens the match. Media opens at its timestamp when supported by its player, PDFs use DigUp's Preview search, and code opens at the matched line in the selected editor.
- **Cmd+Enter** reveals in Finder; **Cmd+Y** opens Quick Look; **Cmd+Shift+C** copies the file; **Cmd+Ctrl+C** copies its path; **Cmd+Option+C** copies its name.
- **Cmd+Shift+P** toggles the preview; **Cmd+R** refreshes. Recent files stay local and can be disabled or cleared.

Spotlight searches your home folder by default. Change **File Name Search Folder** in the extension's preferences
to use another scope. It can only find indexed names. Hidden paths, caches, `node_modules` and bundle interiors
are omitted from name results. Content search respects DigUp's chosen folders, exclusions and separate code setting.

## Build from source

You need an Apple Silicon Mac, full Xcode 26 or later selected with `xcode-select`, Node.js 24, git,
and CMake or `uv`. The first native build downloads DigUp's pinned dependencies. It does not download model weights
or read your personal files.

```sh
git clone https://github.com/Whiteknight07/digup-launcher.git
cd digup-launcher
npm ci --ignore-scripts
npm run package
```

Import `release/digup` into Tinycast. `npm run release` also produces a versioned ZIP and SHA-256 checksum in `artifacts/`.

For a terminal install of a local build:

```sh
bash scripts/install-tinycast.sh --replace-file-search --restart
```

This installs the extension and `files` alias, disables Tinycast's built-in file search, and restarts Tinycast.
It preserves your existing DigUp folders. To set a scope explicitly, first quit DigUp, then add
`--content-root "$HOME"` or the path to another folder. Extensions must already be enabled in Tinycast.

## Development

```sh
npm run typecheck
npm test
npm run lint
npm run build:bridge
python3 tests/bridge_test.py
```

After building the pinned native engine, run its Swift tests with:

```sh
cd .native/digup
swift test --parallel
```

`tests/tinycast-runtime.mjs` can run the built extension in Tinycast's own runtime harness against a
synthetic index. Set `TINYCAST_SOURCE`, `DIGUP_TEST_INDEX` and, if needed, `DIGUP_MODELS` before running it.
The checks cover semantic results, content previews, changes while typing, and Spotlight names.

## How it works

Tinycast buffers subprocess output until exit. The extension starts a small Swift helper with a completed
`execFile` call. That helper keeps `digup search-service` warm and forwards requests over authenticated
HTTP bound to `127.0.0.1` on a random port. A random token is stored in a private discovery file; browser
origins are rejected. The bridge exits after five idle minutes, and the query encoder releases its model after two.

The engine source is pinned in [native/upstream.json](native/upstream.json). A small, inspectable
[patch](native/digup-launcher.patch) adds the app URL handler for settings and matched locations.
The bundled app's stock updater is disabled so an upstream update cannot remove that handler.
Update the extension by downloading a newer release and importing its folder again.

## Credits and contributing

[DigUp](https://github.com/ARahim3/DigUp) by Abdur Rahim provides the engine, indexing app and logo.
The launcher integration is maintained independently. See [NOTICE](NOTICE) for attribution and bundled licenses.
Model files and personal indexes are never shipped in this repo or its releases.

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
