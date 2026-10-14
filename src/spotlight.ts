import { statSync } from "fs";
import { homedir } from "os";
import { Hit, rankNames, spotlightQuery, visiblePath } from "./search";
import { run } from "./process";

export async function nameSearch(
  text: string,
  filter: string,
  scope?: string,
): Promise<Hit[]> {
  if (!text) return [];
  const folder = scope?.startsWith("~/")
    ? homedir() + scope.slice(1)
    : scope || homedir();
  const output = await run("/usr/bin/mdfind", [
    "-0",
    "-onlyin",
    folder,
    spotlightQuery(text, filter),
  ]);
  const hits: Hit[] = [];
  for (const file of output.split("\0").filter(visiblePath).slice(0, 1000)) {
    try {
      const info = statSync(file);
      hits.push({
        path: file,
        kind: info.isDirectory() ? "folder" : "file",
        segment: "name",
        modified: info.mtimeMs / 1000,
        size: info.size,
      });
    } catch {
      /* A result may have moved since Spotlight last saw it. */
    }
  }
  return rankNames(hits, text).slice(0, 100);
}
