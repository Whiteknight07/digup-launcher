// Run our built command in Tinycast's own runtime test harness with real native search.
// TINYCAST_SOURCE=/path/to/tinycast DIGUP_TEST_INDEX=/path/to/synthetic/index node tests/tinycast-runtime.mjs
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.TINYCAST_SOURCE;
const query = process.env.DIGUP_TEST_QUERY;
const index =
  process.env.DIGUP_TEST_INDEX ||
  (query &&
    path.join(homedir(), "Library/Application Support/DigUp/index.noindex"));
if (!source || !index)
  throw new Error(
    "Set TINYCAST_SOURCE and DIGUP_TEST_INDEX to run this integration test.",
  );
const { createHarness, bootConfig } = await import(
  pathToFileURL(path.join(source, "Scripts/raycast-runtime/test.mjs"))
);
const children = new Map();
let backendPaths;
const support = mkdtempSync(path.join(root, "release", "runtime-test-"));
const harness = createHarness({
  stubs: {
    "proc.wait": ([pid]) => children.get(pid),
    "fetch.request": async ([spec]) => {
      const body = spec.bodyBase64
        ? Buffer.from(spec.bodyBase64, "base64")
        : undefined;
      const response = await fetch(spec.url, {
        method: spec.method,
        headers: spec.headers,
        body,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (body && JSON.parse(body).op === "search" && response.ok) {
        backendPaths = JSON.parse(bytes).hits?.map((hit) => hit.path);
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        url: response.url,
        bodyBase64: bytes.toString("base64"),
      };
    },
  },
});
// The upstream Node harness's proc.wait returns empty output. Mirror the installed Swift host,
// which buffers output for execFile, while still executing the real helper and Spotlight.
const originalSync = harness.context.__tinycastHost.invokeSync;
harness.context.__tinycastHost.invokeSync = (api, method, encoded) => {
  if (api !== "proc" || method !== "start")
    return originalSync(api, method, encoded);
  const [spec] = JSON.parse(encoded);
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    cwd: spec.cwd,
  });
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  child.stdin.end(spec.input ? Buffer.from(spec.input, "base64") : undefined);
  const timer = setTimeout(() => child.kill(), spec.timeout || 10_000);
  children.set(
    child.pid,
    new Promise((resolve) => {
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({
          status: status ?? 1,
          stdout: Buffer.concat(stdout).toString("base64"),
          stderr: Buffer.concat(stderr).toString("base64"),
        });
      });
    }),
  );
  return JSON.stringify({ ok: true, value: child.pid });
};
const defaults = bootConfig();
harness.boot(
  bootConfig({
    environment: {
      ...defaults.environment,
      extensionName: "digup",
      commandName: "search-files",
      assetsPath: path.join(root, "release/digup/assets"),
      supportPath: support,
    },
    preferences: {
      indexDirectory: index,
      nameScope:
        process.env.DIGUP_TEST_SCOPE || (query ? homedir() : "/Applications"),
      searchMode: "all",
      rememberRecent: false,
    },
  }),
);
const file = path.join(root, "release/digup/search-files.js");
harness.start(
  "test",
  readFileSync(file, "utf8"),
  file,
  path.dirname(file),
  "view",
  {
    launchProps: {
      fallbackText: query || "rules about having animals in a rental apartment",
    },
  },
);
function nodes(node) {
  if (!node) return [];
  return [
    node,
    ...(node.children || []).flatMap(nodes),
    ...Object.values(node.props || {}).flatMap((value) =>
      value?.type ? nodes(value) : [],
    ),
  ];
}
function current() {
  return nodes(harness.state.trees.at(-1));
}
async function until(predicate, message) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    assert.deepEqual(harness.state.failures, [], "Tinycast runtime failures");
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message + "\n" + JSON.stringify(harness.state.trees.at(-1)));
}
try {
  if (query) {
    await until(
      () =>
        current().some(
          (node) => node.type === "List" && !node.props.isLoading,
        ) &&
        current().some(
          (node) => node.type === "List.Item" && node.props.id !== "status",
        ),
      "Live search did not finish",
    );
    const sections = current().filter((node) => node.type === "List.Section");
    const rows = current().filter(
      (node) => node.type === "List.Item" && node.props.id !== "status",
    );
    assert.equal(
      new Set(rows.map((node) => node.props.id)).size,
      rows.length,
      "Files must not be duplicated",
    );
    if (process.env.DIGUP_EXPECT_NAME_PRIORITY === "1") {
      assert.equal(
        sections[0]?.props.title,
        "Name Matches",
        "Direct filenames must lead the live search",
      );
      assert.ok(
        sections[0].children.every(
          (node) => !node.props.title.startsWith("Screenshot "),
        ),
        "Related screenshots must not precede direct filename matches",
      );
    }
    if (/^content:/i.test(query)) {
      assert.ok(
        !sections.some((node) => node.props.title === "Name Matches"),
        "Explicit content search must keep DigUp ranking",
      );
      assert.deepEqual(
        rows.map((node) => node.props.id),
        backendPaths,
      );
    }
    if (process.env.DIGUP_EXPECT_CONTENT_PRIORITY === "1") {
      assert.equal(
        sections[0]?.props.title,
        "Content Matches",
        "Descriptive searches must lead with content results",
      );
      assert.deepEqual(
        rows.slice(0, backendPaths.length).map((node) => node.props.id),
        backendPaths,
      );
    }
    console.log(
      JSON.stringify(
        {
          query,
          sections: sections.map((node) => ({
            title: node.props.title,
            count: node.children.length,
          })),
          firstResults: rows.slice(0, 8).map((node) => node.props.title),
          uniqueFiles: rows.length,
        },
        null,
        2,
      ),
    );
  } else {
    await until(
      () => current().some((node) => node.props?.title === "lease.txt"),
      "Semantic result did not render",
    );
    let list = current().find((node) => node.type === "List");
    let lease = current().find((node) => node.props?.title === "lease.txt");
    harness.dispatch("test", list.props.onSelectionChange.$fn, [
      lease.props.id,
    ]);
    await until(
      () =>
        current().some(
          (node) =>
            node.type === "List.Item.Detail" &&
            /tenant|apartment/i.test(node.props.markdown || ""),
        ),
      "Content preview did not render",
    );
    list = current().find((node) => node.type === "List");
    harness.dispatch("test", list.props.onSearchTextChange.$fn, ["pet damage"]);
    harness.dispatch("test", list.props.onSearchTextChange.$fn, [
      "power adapter",
    ]);
    await until(
      () =>
        current().some((node) => node.props?.title === "receipt.txt") &&
        !current().some((node) => node.props?.title === "lease.txt"),
      "Latest query did not replace prior results",
    );
    list = current().find((node) => node.type === "List");
    harness.dispatch("test", list.props.onSearchTextChange.$fn, [
      "name: Tinycast",
    ]);
    await until(
      () => current().some((node) => node.props?.title === "Tinycast.app"),
      "Spotlight names did not render",
    );
    console.log(
      "Tinycast runtime: semantic search, content preview, latest-query handling and real Spotlight names passed.",
    );
  }
  assert.deepEqual(harness.state.failures, []);
} finally {
  harness.stop("test");
  const discovery = path.join(support, "bridge/bridge.json");
  try {
    process.kill(JSON.parse(readFileSync(discovery, "utf8")).pid, "SIGTERM");
  } catch {
    /* The idle bridge may already have exited. */
  }
  rmSync(support, { recursive: true, force: true });
}
