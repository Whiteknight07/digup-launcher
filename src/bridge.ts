import { environment, getPreferenceValues, open } from "@raycast/api";
import { existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { run } from "./process";
import { Hit, matchLink } from "./search";

export interface Preferences {
  indexDirectory?: string;
  nameScope?: string;
  searchMode: "all" | "names" | "content";
  rememberRecent: boolean;
}
interface Connection {
  port: number;
  token: string;
}
let connection: Promise<Connection> | undefined;

export function appPath(): string {
  // This copy includes the URL handler for opening the page, moment or code line that matched.
  return path.join(environment.assetsPath, "DigUp.app");
}

async function start(): Promise<Connection> {
  const preferences = getPreferenceValues<Preferences>();
  let index = preferences.indexDirectory;
  if (!index) {
    try {
      index = (
        await run("/usr/bin/defaults", [
          "read",
          "com.abdurrahim.DigUp",
          "indexDir",
        ])
      ).trim();
    } catch {
      /* default */
    }
  }
  index ||= path.join(
    homedir(),
    "Library",
    "Application Support",
    "DigUp",
    "index.noindex",
  );
  if (index.startsWith("~/")) index = path.join(homedir(), index.slice(2));
  const helper = path.join(environment.assetsPath, "digup-bridge");
  const engine = path.join(appPath(), "Contents", "Helpers", "digup");
  if (!existsSync(helper) || !existsSync(engine))
    throw new Error(
      "Native helpers are missing. Run npm run package, then import the release folder.",
    );
  const reply = JSON.parse(
    await run(helper, [
      "--start",
      "--state",
      path.join(environment.supportPath, "bridge"),
      "--engine",
      engine,
      "--index",
      index,
    ]),
  ) as Connection;
  if (
    !Number.isInteger(reply.port) ||
    reply.port < 1 ||
    reply.port > 65535 ||
    typeof reply.token !== "string"
  )
    throw new Error("Invalid local bridge response");
  return reply;
}

export async function rpc<T>(fields: Record<string, unknown>): Promise<T> {
  const bridge = await (connection ||= start().catch((error) => {
    connection = undefined;
    throw error;
  }));
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 30_000);
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fields),
      signal: abort.signal,
    });
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok || body.error)
      throw new Error(
        body.error || `Search bridge returned ${response.status}`,
      );
    return body;
  } catch (error) {
    connection = undefined;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function openMatch(hit: Hit, query: string) {
  if (hit.segment_id === undefined) return open(hit.path);
  // Choose our app explicitly: other DigUp installs may not have launcher URL support yet.
  await open(matchLink(hit, query), appPath());
}

export async function openSetup() {
  await open("digup://settings", appPath());
}
