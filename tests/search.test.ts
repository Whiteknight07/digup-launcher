import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Hit,
  location,
  matchLink,
  queryParts,
  rankNames,
  spotlightQuery,
  uniqueNames,
  visiblePath,
} from "../src/search";

const hit = (file: string): Hit => ({
  path: file,
  kind: "file",
  segment: "name",
});

test("mode prefixes and descriptions are handled without changing the user's words", () => {
  assert.deepEqual(queryParts("  CODE: retry with backoff", "names"), {
    text: "retry with backoff",
    code: true,
    mode: "content",
  });
  assert.deepEqual(queryParts("name: invoice 2026", "content"), {
    text: "invoice 2026",
    code: false,
    mode: "names",
  });
  assert.equal(queryParts("content: Bengali lease", "all").mode, "content");
  assert.equal(queryParts("report: annual", "all").text, "report: annual");
  assert.equal(queryParts("code:", "all").text, "");
});

test("Spotlight expressions escape query syntax and narrow the candidates by type", () => {
  const query = spotlightQuery('report" || *?', "folder");
  assert.match(query, /report\\"/);
  assert.match(query, /\\\*\\\?/);
  assert.match(query, /kMDItemContentType == "public.folder"/);
  assert.equal(
    spotlightQuery("annual report", "all").split("kMDItemFSName").length,
    3,
  );
});

test("name results exclude hidden files, caches and bundle internals", () => {
  assert.equal(visiblePath("/Users/me/.ssh/key"), false);
  assert.equal(visiblePath("/Users/me/app/node_modules/README.md"), false);
  assert.equal(visiblePath("/Applications/App.app/Contents/data"), false);
  assert.equal(visiblePath("/Users/me/Documents/lease.pdf"), true);
  assert.equal(visiblePath("/Applications/App.app"), true);
});

test("merging preserves DigUp's rank, removes duplicates and ranks exact names first", () => {
  const content = [hit("/a/annual report.pdf")];
  assert.deepEqual(
    uniqueNames([...content, hit("/b/report"), hit("/b/report")], content).map(
      (item) => item.path,
    ),
    ["/b/report"],
  );
  const ranked = rankNames(
    [hit("/a/my report"), hit("/b/report 2026"), hit("/c/report")],
    "report",
  );
  assert.deepEqual(
    ranked.map((item) => item.path),
    ["/c/report", "/b/report 2026", "/a/my report"],
  );
});

test("match links preserve Unicode, newlines, special characters and locations", () => {
  const original: Hit = {
    ...hit("/Users/me/Bengali বাংলা #1 & lease\n.pdf"),
    kind: "pdf",
    segment: "page",
    segment_id: 23,
    loc: 4,
  };
  const url = new URL(matchLink(original, "pets & dogs?"));
  assert.deepEqual(JSON.parse(url.searchParams.get("hit")!), original);
  assert.equal(url.searchParams.get("query"), "pets & dogs?");
  assert.equal(location(original), "Page 4");
  assert.equal(
    location({ ...hit("/clip"), segment: "audio", loc: 75.4 }),
    "1:15",
  );
  assert.equal(
    location({ ...hit("/source"), segment: "lines", loc: 10, focus: 28 }),
    "Line 28",
  );
});
