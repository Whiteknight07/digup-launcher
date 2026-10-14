import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = process.env.DIGUP_PACKAGE_ROOT
  ? path.resolve(process.env.DIGUP_PACKAGE_ROOT) + path.sep
  : fileURLToPath(new URL("../release/digup/", import.meta.url));
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? [file, ...walk(file)] : [file];
  });
}

test("every command and native helper is present and executable", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const source = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.version, source.version);
  for (const command of manifest.commands)
    assert.ok(existsSync(path.join(root, `${command.name}.js`)));
  for (const file of [
    "assets/digup-bridge",
    "assets/DigUp.app/Contents/Helpers/digup",
    "assets/DigUp.app/Contents/MacOS/DigUp",
  ])
    assert.ok(
      lstatSync(path.join(root, file)).mode & 0o111,
      `${file} is executable`,
    );
});

test("the distributable contains required attribution, and no models or private state", () => {
  for (const file of [
    "LICENSE",
    "NOTICE",
    "README.md",
    "assets/LICENSE.DigUp.txt",
    "assets/LICENSE.digup-launcher.txt",
    "assets/NOTICE.txt",
    "assets/DigUp.app/Contents/Resources/Acknowledgements.txt",
  ])
    assert.ok(existsSync(path.join(root, file)), `${file} is present`);
  for (const file of walk(root)) {
    assert.doesNotMatch(file, /\.(gguf|sqlite|sqlite3|log|js\.map)$/);
    assert.ok(
      !["node_modules", ".git", "bridge.json"].includes(path.basename(file)),
    );
  }
});

test("framework links stay relative and inside the package after import", () => {
  let count = 0;
  for (const file of walk(root)) {
    if (!lstatSync(file).isSymbolicLink()) continue;
    count++;
    const target = readlinkSync(file);
    assert.ok(!path.isAbsolute(target), `${file} must be relocatable`);
    const resolved = path.resolve(path.dirname(file), target);
    assert.ok(
      resolved.startsWith(root),
      `${file} must stay within the package`,
    );
    assert.ok(existsSync(file), `${file} resolves to an existing file`);
  }
  assert.ok(count > 0, "Sparkle framework links were preserved");
});

test("the bundled app passes macOS signature verification", () => {
  execFileSync("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    path.join(root, "assets/DigUp.app"),
  ]);
});
