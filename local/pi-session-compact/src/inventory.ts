import { originalProjection, assertOriginalHistory } from "./quotations.ts";
import { type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Pi 1.5 builtin normalizePath/resolveToCwd grammar. Pi does not export its resolver;
 * keep this string-only parser aligned via the public write tool's operations boundary.
 */
function builtinAbsolutePath(input: string, cwd: string): string {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || process.platform === "win32" && path.startsWith("~\\")) path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(cwd, path);
}

/** Paths remain complete; order is oldest to newest observation. */
export interface FileInventory {
  readFiles: string[];
  modifiedFiles: string[];
  order: string[];
  /** Cumulative evictions, not a count of distinct paths (evicted paths may reappear). */
  omitted: number;
}
export interface Inventory { fileTracking: FileInventory; legacyFileTracking?: FileInventory }
interface PreviousDetails {
  generator?: string;
  fileTracking?: Partial<FileInventory>;
  readFiles?: unknown;
  modifiedFiles?: unknown;
  nativeDetails?: PreviousDetails;
  legacyFileTracking?: FileInventory;
}
const paths = (value: unknown): string[] => Array.isArray(value) ? value.filter((p): p is string => typeof p === "string" && p.length > 0) : [];

/** Pi 1.3 grammar: builtin read/write/edit(path), including codemode nested calls.
 * Use the public current projection so deleted/replaced calls and retained tail are excluded.
 * Extensions own their details; never scrape model-written summaries for inventories.
 */
export function collectInventory(branch: SessionEntry[], firstKeptEntryId: string, cwd: string): Inventory {
  // Lexical identity also works for deleted files; inventory must not depend on current disk state.
  // Keep failed parses in a separate identity namespace; only display values leave this function.
  const normalizePath = (path: string): string => {
    try {
      const absolute = builtinAbsolutePath(path, cwd);
      const local = relative(cwd, absolute);
      const display = local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? (/^[~@]/.test(local) ? `.${sep}${local}` : local || ".") : absolute;
      return `resolved:${display}`;
    } catch {
      // Inventories include failed tool calls. A malformed URI has no resolved file identity.
      return `raw:${path}`;
    }
  };
  const displayPath = (key: string): string => key.slice(key.indexOf(":") + 1);
  const previous = branch.findLast((entry) => entry.type === "compaction");
  const details = previous?.details as PreviousDetails | undefined;
  const own = details?.generator === "pi-session-compact";
  const prior = own ? details.fileTracking : previous && !previous.fromHook ? details : details?.generator === "pi-native" ? details.nativeDetails : undefined;
  const files = new Map<string, boolean>();
  const legacy = new Map<string, boolean>();
  const priorLegacy = details?.legacyFileTracking;
  const projection = originalProjection(branch);
  const keptAt = projection.entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
  if (keptAt < 0) throw new Error("inventory-kept-boundary-unavailable");
  const addTo = (target: Map<string, boolean>, name: unknown, args: unknown) => {
    if (name !== "read" && name !== "write" && name !== "edit") return;
    const rawPath = (args as { path?: unknown } | null)?.path;
    if (typeof rawPath !== "string" || !rawPath) return;
    const path = normalizePath(rawPath);
    const changed = target.get(path) ?? false; target.delete(path); target.set(path, changed || name !== "read");
  };
  const scan = (entries: ReturnType<typeof originalProjection>["entries"], target: Map<string, boolean>) => {
    for (const entry of entries) for (const message of entry.messages) {
      if (message.role === "assistant") for (const block of message.content) { if (block.type === "toolCall") addTo(target, block.name, block.arguments); }
      else if (message.role === "toolResult") for (const call of message.nestedCalls?.calls ?? []) addTo(target, call.name, call.arguments);
    }
  };
  scan(projection.entries.slice(0, keptAt), files);
  // Raw observations identify which inherited cache paths have explicit editable originals.
  // Never resurrect those after deletion/replacement. Cache-only paths stay labelled legacy.
  const raw = branch.map(e => e.type === "context_edit" ? { type: "custom" as const, id: e.id, parentId: e.parentId, timestamp: e.timestamp, customType: "inventory-raw-edit", data: null } : e);
  const original = new Map<string, boolean>(); scan(originalProjection(raw).entries.slice(0, previous ? branch.findIndex(e => e.id === previous.firstKeptEntryId) : keptAt), original);
  let complete = true; try { assertOriginalHistory(branch); } catch { complete = false; }
  for (const source of [prior, priorLegacy]) {
    for (const path of paths(source?.readFiles).map(normalizePath)) if (!files.has(path) && (!complete || !original.has(path)) && !legacy.has(path)) legacy.set(path, false);
    for (const path of paths(source?.modifiedFiles).map(normalizePath)) if (files.get(path) !== true && (!complete || original.get(path) !== true)) legacy.set(path, true);
  }
  const previousOmitted = own ? details.fileTracking?.omitted : 0;
  const omitted = [previousOmitted, priorLegacy?.omitted].reduce<number>((sum, n) => sum + (typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0), 0);
  const inventory = (items: Map<string, boolean>, omitted = 0): FileInventory => ({ readFiles: [...items].filter(([, changed]) => !changed).map(([path]) => displayPath(path)), modifiedFiles: [...items].filter(([, changed]) => changed).map(([path]) => displayPath(path)), order: [...items.keys()].map(displayPath), omitted });
  return { fileTracking: inventory(files), ...(legacy.size || omitted ? { legacyFileTracking: inventory(legacy, omitted) } : {}) };
}

export function renderInventory({ fileTracking: files, legacyFileTracking: legacy }: Inventory): string {
  const sections: string[] = [];
  if (files.readFiles.length) sections.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
  if (files.modifiedFiles.length) sections.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
  if (legacy) sections.push(`Legacy file inventory (original calls unavailable; not reverified):\n${[...legacy.readFiles.map(p => `read: ${p}`), ...legacy.modifiedFiles.map(p => `modified: ${p}`), ...(legacy.omitted ? [`${legacy.omitted} old observations were omitted by a previous version.`] : [])].join("\n")}`);
  if (files.omitted) sections.push(`Legacy file tracking omitted ${files.omitted} path observations; original branch entries were rescanned where available.`);
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}
