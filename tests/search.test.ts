import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Hit,
  location,
  matchLink,
  queryParts,
  rankNames,
  spotlightQuery,
  nameMatchRank,
  mergeResults,
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

test("name ranking puts exact names before prefixes and incidental substrings", () => {
  const ranked = rankNames(
    [hit("/a/my report"), hit("/b/report 2026"), hit("/c/report")],
    "report",
  );
  assert.deepEqual(
    ranked.map((item) => item.path),
    ["/c/report", "/b/report 2026", "/a/my report"],
  );
});

test("a marksheet name match outranks related screenshots without losing its PDF preview", () => {
  const file = hit("/files/Class 12 marksheet.pdf");
  const indexed = {
    ...file,
    kind: "pdf",
    segment: "page",
    segment_id: 42,
    loc: 3,
    excerpt: "Student results",
  };
  const screenshots = Array.from({ length: 15 }, (_, i) => ({
    ...hit(`/files/Screenshot ${i}.png`),
    kind: "screenshot",
    segment: "ocr",
  }));
  const result = mergeResults(
    [file, file],
    [...screenshots, indexed],
    "marksheet",
  );
  assert.deepEqual(result.directNames, [indexed]);
  assert.deepEqual(result.contentMatches, screenshots);
  assert.deepEqual(result.otherNames, []);
});

test("strong content-only filenames can be promoted even before Spotlight finds them", () => {
  const file = hit("/files/marksheet.pdf");
  const result = mergeResults(
    [],
    [hit("/files/Screenshot.png"), file],
    "marksheet",
  );
  assert.deepEqual(result.directNames, [file]);
});

test("weak substring matches don't outrank semantic results", () => {
  const partial = hit("/files/cartography.pdf");
  const relevant = hit("/files/IMG_0042.jpg");
  const result = mergeResults([partial], [relevant], "art");
  assert.deepEqual(result.directNames, []);
  assert.deepEqual(result.contentMatches, [relevant]);
  assert.deepEqual(result.otherNames, [partial]);
});

test("descriptive searches preserve DigUp's content order and explicit content mode never promotes names", () => {
  const content = [hit("/files/scan-01.pdf"), hit("/files/lease.pdf")];
  assert.deepEqual(
    mergeResults([], content, "rules about pets in my apartment")
      .contentMatches,
    content,
  );
  const explicit = mergeResults([content[1]], content, "lease", false);
  assert.deepEqual(explicit.directNames, []);
  assert.deepEqual(explicit.contentMatches, content);
  assert.deepEqual(explicit.otherNames, []);
});

test("multiword, accented, camelCase and prefix filename searches qualify; numeric IDs don't collide", () => {
  assert.equal(nameMatchRank(hit("/files/marksheet.pdf"), "marksheet"), 0);
  assert.equal(
    nameMatchRank(hit("/files/Annual Report 2026.pdf"), "report annual"),
    1,
  );
  assert.equal(
    nameMatchRank(hit("/files/Café invoices.pdf"), "cafe invoices"),
    0,
  );
  assert.equal(
    nameMatchRank(hit("/files/Class12Marksheet.pdf"), "class12 marksheet"),
    1,
  );
  assert.equal(
    nameMatchRank(hit("/files/Class 12 marksheets.pdf"), "class 12 marksh"),
    2,
  );
  assert.equal(
    nameMatchRank(hit("/files/invoice 12345.pdf"), "invoice 1234"),
    undefined,
  );
  assert.equal(nameMatchRank(hit("/files/mark-sheets.pdf"), ""), undefined);
});

test("exact names beat word and prefix matches, folders are included, and each path appears once", () => {
  const exact = hit("/files/marksheet.pdf");
  const folder = { ...hit("/files/Old marksheet"), kind: "folder" };
  const prefix = hit("/files/marksheets.pdf");
  const result = mergeResults(
    [prefix, folder, exact, exact],
    [prefix, hit("/files/image.png"), prefix],
    "marksheet",
  );
  assert.deepEqual(
    result.directNames.map((hit) => hit.path),
    [exact.path, folder.path, prefix.path],
  );
  const all = [
    ...result.directNames,
    ...result.contentMatches,
    ...result.otherNames,
  ];
  assert.equal(new Set(all.map((hit) => hit.path)).size, all.length);
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
