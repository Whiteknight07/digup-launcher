import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  Keyboard,
  LaunchProps,
  List,
  LocalStorage,
  Toast,
  getPreferenceValues,
  closeMainWindow,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { useEffect, useState } from "react";
import { Preferences, openMatch, openSetup, rpc } from "./bridge";
import {
  Hit,
  Mode,
  SearchReply,
  location,
  markdownText,
  queryParts,
  mergeResults,
} from "./search";
import { nameSearch } from "./spotlight";

const recentKey = "recent-files";
const filters = [
  ["all", "All Types"],
  ["folder", "Folders"],
  ["image", "Images"],
  ["pdf", "PDFs"],
  ["doc", "Documents"],
  ["audio", "Audio"],
  ["video", "Videos"],
  ["archive", "Archives"],
  ["code", "Code"],
];

async function remember(hit: Hit) {
  if (!getPreferenceValues<Preferences>().rememberRecent) return;
  const saved = await LocalStorage.getItem<string>(recentKey);
  let recent: Hit[] = [];
  try {
    recent = JSON.parse(saved || "[]");
  } catch {
    /* Reset damaged history. */
  }
  await LocalStorage.setItem(
    recentKey,
    JSON.stringify(
      [hit, ...recent.filter((old) => old.path !== hit.path)].slice(0, 20),
    ),
  );
}

function SetupActions({ retry }: { retry: () => void }) {
  return (
    <ActionPanel>
      <Action
        title="Open DigUp Settings"
        icon={Icon.Gear}
        onAction={openSetup}
      />
      <Action
        title="Retry Search"
        icon={Icon.ArrowClockwise}
        onAction={retry}
      />
      <Action
        title="Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </ActionPanel>
  );
}

function ResultDetail({ hit, code }: { hit: Hit; code: boolean }) {
  const [text, setText] = useState(hit.excerpt || "");
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let active = true;
    setText(hit.excerpt || "");
    setImage(undefined);
    if (
      hit.segment_id !== undefined &&
      !["image", "screenshot", "video"].includes(hit.kind)
    ) {
      rpc<{ text?: string }>({ op: "text", segment: hit.segment_id, code })
        .then((reply) => {
          if (active && reply.text) setText(reply.text.slice(0, 8000));
        })
        .catch(() => {
          /* The excerpt remains usable if preview extraction fails. */
        });
    }
    if (["image", "screenshot", "pdf", "video"].includes(hit.kind)) {
      rpc<{ image?: string }>({
        op: "render",
        path: hit.path,
        kind: hit.kind === "screenshot" ? "image" : hit.kind,
        loc: hit.loc,
        pixels: 1000,
      })
        .then((reply) => {
          if (active) setImage(reply.image);
        })
        .catch(() => {
          /* Metadata still renders. */
        });
    }
    return () => {
      active = false;
    };
  }, [hit.path, hit.segment_id, hit.loc, hit.excerpt, hit.kind, code]);
  const preview = image
    ? `![Preview](<${encodeURI("file://" + image)}>)\n\n`
    : "";
  return (
    <List.Item.Detail
      markdown={
        preview +
        (text
          ? markdownText(text)
          : `**${markdownText(path.basename(hit.path))}**`)
      }
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label
            title="Location"
            text={hit.path.replace(homedir(), "~")}
          />
          <List.Item.Detail.Metadata.Label title="Type" text={hit.kind} />
          {location(hit) && (
            <List.Item.Detail.Metadata.Label
              title="Match"
              text={location(hit)}
            />
          )}
          {hit.size !== undefined && (
            <List.Item.Detail.Metadata.Label
              title="Size"
              text={`${(hit.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`}
            />
          )}
          {!!hit.modified && (
            <List.Item.Detail.Metadata.Label
              title="Modified"
              text={new Date(hit.modified * 1000).toLocaleString()}
            />
          )}
        </List.Item.Detail.Metadata>
      }
    />
  );
}

export default function Command(
  props: LaunchProps<{ arguments: { query?: string } }>,
) {
  const preferences = getPreferenceValues<Preferences>();
  const [query, setQuery] = useState(
    props.arguments.query || props.fallbackText || "",
  );
  const [mode, setMode] = useState<Mode>(preferences.searchMode || "all");
  const [filter, setFilter] = useState("all");
  const [content, setContent] = useState<Hit[]>([]);
  const [names, setNames] = useState<Hit[]>([]);
  const [recent, setRecent] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [nameError, setNameError] = useState("");
  const [details, setDetails] = useState(true);
  const [selected, setSelected] = useState<string>();
  const [revision, setRevision] = useState(0);
  const parsed = queryParts(query, mode);
  const code = parsed.code || filter === "code";
  const retry = () => setRevision((value) => value + 1);

  useEffect(() => {
    if (!preferences.rememberRecent) return;
    LocalStorage.getItem<string>(recentKey).then((saved) => {
      try {
        setRecent(
          (JSON.parse(saved || "[]") as Hit[]).filter((hit) =>
            existsSync(hit.path),
          ),
        );
      } catch {
        setRecent([]);
      }
    });
  }, [preferences.rememberRecent, revision]);

  useEffect(() => {
    let active = true;
    setContent([]);
    setNames([]);
    setMessage("");
    setNameError("");
    if (!parsed.text) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const tasks: Promise<void>[] = [];
      if (parsed.mode !== "content" && !code) {
        tasks.push(
          nameSearch(parsed.text, filter, preferences.nameScope)
            .then((hits) => {
              if (active) setNames(hits);
            })
            .catch((error) => {
              if (active) setNameError(`File name search: ${String(error)}`);
            }),
        );
      }
      if (parsed.mode !== "names" || code) {
        if (["folder", "archive"].includes(filter)) {
          if (parsed.mode === "content")
            setMessage(
              "Use Names and Content or Names Only to find folders and archives.",
            );
        } else {
          const kinds =
            filter === "image"
              ? ["image", "screenshot"]
              : filter === "doc"
                ? ["doc", "pdf"]
                : ["all", "code"].includes(filter)
                  ? undefined
                  : [filter];
          tasks.push(
            rpc<SearchReply>({
              op: "search",
              q: parsed.text,
              code,
              kinds,
              meaning: true,
              limit: 60,
            })
              .then((reply) => {
                if (!active) return;
                setContent(reply.hits);
                setMessage(
                  reply.warning ||
                    (!reply.meaning
                      ? "Content search is using exact words. Open DigUp to check the model and indexing."
                      : ""),
                );
              })
              .catch((error) => {
                if (active) setMessage(String(error).replace(/^Error: /, ""));
              }),
          );
        }
      }
      Promise.all(tasks).finally(() => {
        if (active) setLoading(false);
      });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [parsed.text, parsed.mode, code, filter, preferences.nameScope, revision]);

  const renderHit = (hit: Hit) => {
    const id = hit.path;
    return (
      <List.Item
        key={id}
        id={id}
        title={path.basename(hit.path)}
        icon={{ fileIcon: hit.path }}
        quickLook={{ path: hit.path }}
        subtitle={
          details ? undefined : path.dirname(hit.path).replace(homedir(), "~")
        }
        accessories={location(hit) ? [{ text: location(hit) }] : []}
        detail={
          details && selected === id ? (
            <ResultDetail hit={hit} code={code || hit.kind === "code"} />
          ) : undefined
        }
        actions={
          <ActionPanel>
            <Action
              title="Open"
              icon={Icon.Document}
              onAction={async () => {
                try {
                  await openMatch(hit, parsed.text);
                  await remember(hit);
                  await closeMainWindow();
                } catch (error) {
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Could not open file",
                    message: String(error),
                  });
                }
              }}
            />
            <Action.ShowInFinder path={hit.path} />
            <Action.ToggleQuickLook
              shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
            />
            <Action
              title="Copy File"
              icon={Icon.Clipboard}
              shortcut={Keyboard.Shortcut.Common.Copy}
              onAction={() => Clipboard.copy({ file: hit.path })}
            />
            <Action.CopyToClipboard
              title="Copy Path"
              content={hit.path}
              shortcut={Keyboard.Shortcut.Common.CopyPath}
            />
            <Action.CopyToClipboard
              title="Copy Name"
              content={path.basename(hit.path)}
              shortcut={Keyboard.Shortcut.Common.CopyName}
            />
            <Action
              title={details ? "Hide Preview" : "Show Preview"}
              icon={Icon.Sidebar}
              shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
              onAction={() => setDetails(!details)}
            />
            <ActionPanel.Submenu
              title="Search Mode"
              icon={Icon.MagnifyingGlass}
            >
              <Action
                title="Names and Content"
                onAction={() => setMode("all")}
              />
              <Action title="Names Only" onAction={() => setMode("names")} />
              <Action
                title="Content Only"
                onAction={() => setMode("content")}
              />
            </ActionPanel.Submenu>
            <Action
              title="Open DigUp Settings"
              icon={Icon.Gear}
              onAction={openSetup}
            />
            <Action
              title="Refresh Results"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={retry}
            />
            <Action
              title="Clear Recent Files"
              icon={Icon.Trash}
              onAction={async () => {
                await LocalStorage.removeItem(recentKey);
                setRecent([]);
              }}
            />
            <Action
              title="Extension Preferences"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
          </ActionPanel>
        }
      />
    );
  };
  const results = mergeResults(
    names,
    content,
    parsed.text,
    parsed.mode === "all" && !code,
  );
  const status = [message, nameError].filter(Boolean).join(" ");
  return (
    <List
      navigationTitle="Search Files with DigUp"
      searchBarPlaceholder="File name or description · code: searches source code"
      searchText={query}
      onSearchTextChange={setQuery}
      filtering={false}
      isLoading={loading}
      isShowingDetail={details}
      onSelectionChange={(id) => setSelected(id || undefined)}
      searchBarAccessory={
        <List.Dropdown tooltip="File Type" value={filter} onChange={setFilter}>
          {filters.map(([value, title]) => (
            <List.Dropdown.Item key={value} value={value} title={title} />
          ))}
        </List.Dropdown>
      }
    >
      {!parsed.text && (
        <List.Section title="Recently Opened">
          {recent.map(renderHit)}
        </List.Section>
      )}
      {results.directNames.length > 0 && (
        <List.Section title="Name Matches">
          {results.directNames.map(renderHit)}
        </List.Section>
      )}
      {results.contentMatches.length > 0 && (
        <List.Section title={code ? "Code" : "Content Matches"}>
          {results.contentMatches.map(renderHit)}
        </List.Section>
      )}
      {results.otherNames.length > 0 && (
        <List.Section
          title={
            results.directNames.length
              ? "More Name Matches"
              : "File and Folder Names"
          }
        >
          {results.otherNames.map(renderHit)}
        </List.Section>
      )}
      {status && (
        <List.Item
          id="status"
          title="Search Status"
          subtitle={details ? undefined : status}
          icon={Icon.Info}
          detail={<List.Item.Detail markdown={markdownText(status)} />}
          actions={<SetupActions retry={retry} />}
        />
      )}
      <List.EmptyView
        icon={Icon.MagnifyingGlass}
        title={parsed.text ? "No Files Found" : "Search Your Files"}
        description={
          parsed.text
            ? "Try a name, describe what's inside, or change the file type."
            : "Type a file name or a description. Use name:, content:, or code: to choose a search mode."
        }
        actions={<SetupActions retry={retry} />}
      />
    </List>
  );
}
