import path from "path";

export interface Hit {
  path: string;
  kind: string;
  segment: string;
  segment_id?: number;
  loc?: number;
  loc_end?: number;
  focus?: number;
  excerpt?: string;
  modified?: number;
  size?: number;
  info?: Record<string, string>;
  z?: number;
  keyword_rank?: number;
}
export interface SearchReply {
  hits: Hit[];
  strong: number;
  meaning: boolean;
  warning?: string;
}
export type Mode = "all" | "names" | "content";

export function queryParts(raw: string, mode: Mode) {
  const match = raw.match(/^\s*(code|name|content):\s*/i);
  return {
    text: raw
      .slice(match?.[0].length ?? 0)
      .trim()
      .slice(0, 4096),
    code: match?.[1].toLowerCase() === "code",
    mode:
      match?.[1].toLowerCase() === "name" ? "names" : match ? "content" : mode,
  };
}

// Escape Spotlight's query language; the query is passed as one argv entry, never through a shell.
export function spotlightQuery(text: string, filter: string): string {
  const words = text.trim().split(/\s+/u).filter(Boolean).slice(0, 32);
  const terms = words.map((word) => {
    const literal = word.replace(/[\\"*?]/g, "\\$&");
    return `kMDItemFSName == "*${literal}*"cd`;
  });
  const types: Record<string, string> = {
    folder: 'kMDItemContentType == "public.folder"',
    image: '(kMDItemContentTypeTree == "public.image")',
    pdf: 'kMDItemContentType == "com.adobe.pdf"',
    doc: '(kMDItemContentTypeTree == "public.text" || kMDItemContentTypeTree == "public.composite-content")',
    audio: 'kMDItemContentTypeTree == "public.audio"',
    video: 'kMDItemContentTypeTree == "public.movie"',
    archive: 'kMDItemContentTypeTree == "public.archive"',
  };
  if (types[filter]) terms.push(types[filter]);
  return terms.join(" && ");
}

export function visiblePath(file: string): boolean {
  return (
    file.startsWith("/") &&
    !file
      .split("/")
      .some(
        (part) =>
          part.startsWith(".") ||
          ["node_modules", "Caches", "DerivedData"].includes(part),
      ) &&
    !/\.(app|bundle|framework)\//i.test(file)
  );
}

export function location(hit: Hit): string | undefined {
  if (hit.loc === undefined) return undefined;
  if (["page", "pageImage", "page_image"].includes(hit.segment))
    return `Page ${Math.trunc(hit.loc)}`;
  if (hit.segment === "lines")
    return `Line ${Math.trunc(hit.focus ?? hit.loc)}`;
  if (hit.segment === "cells") return `Cell ${Math.trunc(hit.loc)}`;
  if (["frame", "audio"].includes(hit.segment)) {
    const seconds = Math.max(0, Math.trunc(hit.loc));
    return `${Math.trunc(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return undefined;
}

function folded(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function words(text: string): string[] {
  // Treat spaces, punctuation and camelCase as word boundaries, as filenames commonly use all three.
  return (
    folded(text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")).match(
      /[\p{L}\p{N}]+/gu,
    ) ?? []
  );
}

/** Strong literal name evidence, independent of DigUp's semantic scores. Incidental substrings
 * ("art" in "cartography") don't displace a relevant content match. */
export function nameMatchRank(hit: Hit, query: string): number | undefined {
  const name = path.basename(hit.path);
  const stem =
    hit.kind === "folder"
      ? name
      : name.slice(0, name.length - path.extname(name).length);
  const literal = folded(query.trim());
  if (!literal) return undefined;
  if (folded(name) === literal || folded(stem) === literal) return 0;
  const terms = words(query);
  const filenameWords = words(name);
  if (!terms.length) return undefined;
  if (terms.every((term) => filenameWords.includes(term))) return 1;
  // Only the final word may be unfinished while typing. Numeric IDs must match in full.
  const last = terms.length - 1;
  if (
    terms.every((term, i) =>
      filenameWords.some(
        (word) =>
          word === term ||
          (i === last &&
            term.length >= 3 &&
            /\p{L}/u.test(term) &&
            word.startsWith(term)),
      ),
    )
  )
    return 2;
  return undefined;
}

export function mergeResults(
  names: Hit[],
  content: Hit[],
  query: string,
  boostNames = true,
) {
  const contentByPath = new Map<string, Hit>();
  for (const hit of content)
    if (!contentByPath.has(hit.path)) contentByPath.set(hit.path, hit);
  const namesByPath = new Map<string, Hit>();
  for (const hit of names)
    if (!namesByPath.has(hit.path)) namesByPath.set(hit.path, hit);
  // Prefer the indexed match's page, timestamp, excerpt and type when both searches find a file.
  const candidates = new Map([...namesByPath, ...contentByPath]);
  const directNames = boostNames
    ? rankNames(
        [...candidates.values()].filter(
          (hit) => nameMatchRank(hit, query) !== undefined,
        ),
        query,
      ).sort((a, b) => nameMatchRank(a, query)! - nameMatchRank(b, query)!)
    : [];
  const promoted = new Set(directNames.map((hit) => hit.path));
  return {
    directNames,
    contentMatches: [...contentByPath.values()].filter(
      (hit) => !promoted.has(hit.path),
    ),
    otherNames: [...namesByPath.values()].filter(
      (hit) => !promoted.has(hit.path) && !contentByPath.has(hit.path),
    ),
  };
}

export function rankNames(hits: Hit[], query: string): Hit[] {
  const text = query.toLocaleLowerCase();
  const score = (hit: Hit) => {
    const name = path.basename(hit.path).toLocaleLowerCase();
    return name === text ? 0 : name.startsWith(text) ? 1 : 2;
  };
  return [...hits].sort(
    (a, b) =>
      score(a) - score(b) ||
      (b.modified ?? 0) - (a.modified ?? 0) ||
      a.path.localeCompare(b.path),
  );
}

export function matchLink(hit: Hit, query: string): string {
  return `digup://open?hit=${encodeURIComponent(JSON.stringify(hit))}&query=${encodeURIComponent(query)}`;
}

export function markdownText(text: string): string {
  return text.replace(/[\\`*_{}[\]<>()!#|]/g, "\\$&");
}
