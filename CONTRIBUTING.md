# Contributing

Report a bug with your macOS version, Mac architecture, launcher version, extension version, search mode,
and steps to reproduce. Use synthetic files when sharing examples. Indexes and debug logs can contain filenames
and queries, so don't attach your personal index or unreviewed logs.

Keep changes focused. Run the TypeScript, formatting and search tests, and the bridge tests for native changes.
Changes to the DigUp patch should also pass the pinned engine's Swift tests.

To update the native engine, change `native/upstream.json`, regenerate `native/digup-launcher.patch` against
that commit, move the old generated `.native/digup` checkout aside, and rebuild. Verify source and release packaging
with `npm run package` and `npm run release`. Preserve the upstream license and acknowledgements.

Changes intended for DigUp itself should follow [its contribution process](https://github.com/ARahim3/DigUp/blob/main/CONTRIBUTING.md).
