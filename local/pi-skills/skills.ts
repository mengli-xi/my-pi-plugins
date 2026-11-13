import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type BigIntStats } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { getAgentDir, loadSkillsFromDir, type Skill, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export const MAX_SKILL_NAME_BYTES = 256;
export const MAX_SKILL_PATH_BYTES = 1_024;

const DEFINITE_SHELL_VARIABLES = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
]);

const SKILL_NAME_CHARACTER = /[A-Za-z0-9_:-]/;

export interface SkillRef {
  name: string;
  description?: string;
  path: string;
  scope: "project" | "user" | "temporary";
}

export interface SkillMention {
  start: number;
  end: number;
  name: string;
}

export interface SkillCommandInvocation {
  name: string;
  args: string;
  normalizedText: string;
}

export interface BoundSkillMention extends SkillMention {
  path: string;
}

export interface LoadedSkill {
  name: string;
  path: string;
  contents: string;
  /** Present only on sidecars written by pi-skills <= 0.1.0. */
  truncated?: boolean;
}

export interface ResolvedMentions {
  skills: SkillRef[];
  ambiguousNames: string[];
}

export interface RuntimeSkillDiscoveryOptions {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
  home?: string;
}

export function getSkillCommands(commands: readonly SlashCommandInfo[]): SkillRef[] {
  return sortSkillRefs(commands
    .filter((command) => command.source === "skill")
    .map((command) => ({
      name: command.name.startsWith("skill:") ? command.name.slice(6) : command.name,
      description: command.description,
      path: command.sourceInfo.path,
      scope: command.sourceInfo.scope,
    })));
}

function scopeRank(scope: SkillRef["scope"]): number {
  return scope === "project" ? 0 : scope === "temporary" ? 1 : 2;
}

function sortSkillRefs(skills: readonly SkillRef[]): SkillRef[] {
  return [...skills].sort((left, right) =>
    scopeRank(left.scope) - scopeRank(right.scope)
      || left.name.localeCompare(right.name)
      || left.path.localeCompare(right.path)
  );
}

function skillRef(skill: Skill): SkillRef {
  const scope = skill.sourceInfo.scope === "project" ? "project" : "user";
  return {
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
    scope,
  };
}

interface CatalogSnapshot {
  versions: Map<string, string>;
  skills: SkillRef[];
}

const runtimeCatalogs = new Map<string, CatalogSnapshot>();
const IGNORE_FILES = new Set([".gitignore", ".ignore", ".fdignore"]);

function statVersion(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

function contentVersion(path: string, stats: BigIntStats): string {
  // Directory timestamps can collide too: include entries to detect additions.
  if (stats.isDirectory()) return JSON.stringify(readdirSync(path).sort());
  if (stats.isFile() && (path.endsWith(".md") || IGNORE_FILES.has(basename(path)))) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return "";
}

function pathMetadata(path: string): { version: string; stats?: BigIntStats } {
  try {
    const link = lstatSync(path, { bigint: true });
    if (!link.isSymbolicLink()) return { version: `${statVersion(link)}:${contentVersion(path, link)}`, stats: link };
    try {
      const target = statSync(path, { bigint: true });
      return { version: `${statVersion(link)}>${statVersion(target)}:${contentVersion(path, target)}`, stats: target };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: `${statVersion(link)}>missing` };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: "missing" };
  }
}

function versionsUnchanged(versions: ReadonlyMap<string, string>): boolean {
  try {
    for (const [path, version] of versions) {
      if (pathMetadata(path).version !== version) return false;
    }
    return true;
  } catch {
    // An unreadable metadata path cannot establish that the catalog is current.
    return false;
  }
}

/**
 * Pi 1.5 core/skills.ts skips hidden entries/node_modules, follows symlinks,
 * and reads .gitignore/.ignore/.fdignore in visited directories. This content/version
 * superset deliberately does not interpret ignore rules or stop at SKILL.md:
 * only the official loader decides which skills exist. Unverifiable metadata
 * disables reuse; additions to this upstream discovery surface require review.
 */
function catalogVersions(dir: string): Map<string, string> | undefined {
  const versions = new Map<string, string>();
  const ancestors = new Set<string>();
  const visit = (path: string) => {
    const { version, stats } = pathMetadata(path);
    versions.set(path, version);
    if (!stats?.isDirectory()) return;
    const identity = `${stats.dev}:${stats.ino}`;
    if (ancestors.has(identity)) return;
    ancestors.add(identity);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || (entry.name.startsWith(".") && !IGNORE_FILES.has(entry.name))) continue;
      const child = join(path, entry.name);
      if (IGNORE_FILES.has(entry.name)) {
        versions.set(child, pathMetadata(child).version);
      } else {
        visit(child);
      }
    }
    ancestors.delete(identity);
  };
  try {
    visit(dir);
    return versions;
  } catch {
    // The official loader retains responsibility for unreadable resources.
    return undefined;
  }
}

function addDiscoveredSkills(output: SkillRef[], dir: string, source: "user" | "project"): void {
  const key = `${source}:${resolve(dir)}`;
  const cached = runtimeCatalogs.get(key);
  if (cached && versionsUnchanged(cached.versions)) {
    output.push(...cached.skills);
    return;
  }
  const versions = catalogVersions(dir);
  const skills = loadSkillsFromDir({ dir, source }).skills.map(skillRef);
  if (versions && versionsUnchanged(versions)) {
    runtimeCatalogs.set(key, { versions, skills });
  } else {
    runtimeCatalogs.delete(key);
  }
  output.push(...skills);
}

function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    dirs.push(current);
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return dirs;
}

export function discoverRuntimeSkillRefs(options: RuntimeSkillDiscoveryOptions): SkillRef[] {
  const skills: SkillRef[] = [];
  const resolvedAgentDir = options.agentDir ?? getAgentDir();
  const resolvedHome = options.home ?? homedir();
  addDiscoveredSkills(skills, join(resolvedAgentDir, "skills"), "user");
  addDiscoveredSkills(skills, join(resolvedHome, ".agents", "skills"), "user");
  if (options.projectTrusted) {
    const cwd = resolve(options.cwd);
    addDiscoveredSkills(skills, join(cwd, ".pi", "skills"), "project");
    for (const dir of ancestorDirs(cwd)) {
      addDiscoveredSkills(skills, join(dir, ".agents", "skills"), "project");
    }
  }
  return sortSkillRefs(skills);
}

export function mergeSkillRefs(...catalogs: readonly SkillRef[][]): SkillRef[] {
  const byPath = new Map<string, SkillRef>();
  for (const catalog of catalogs) {
    for (const skill of catalog) {
      if (!byPath.has(skill.path)) byPath.set(skill.path, skill);
    }
  }
  return sortSkillRefs([...byPath.values()]);
}

export function isSkillNameCharacter(character: string | undefined): boolean {
  return character !== undefined && SKILL_NAME_CHARACTER.test(character);
}

/** Parse Pi's leading `/skill:name args` command without claiming it as inline syntax. */
export function parseSkillCommandInvocation(text: string): SkillCommandInvocation | undefined {
  if (!text.startsWith("/skill:")) return undefined;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  if (!name || [...name].some((character) => !isSkillNameCharacter(character))) return undefined;
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  return {
    name,
    args,
    normalizedText: `$${name}${args ? ` ${args}` : ""}`,
  };
}

/** Codex-style bare `$name` mentions. `$[name]` is deliberately not syntax. */
export function findSkillMentions(text: string): SkillMention[] {
  const mentions: SkillMention[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "$" || !isSkillNameCharacter(text[start + 1])) continue;
    let end = start + 2;
    while (isSkillNameCharacter(text[end])) end++;
    const name = text.slice(start + 1, end);
    if (!DEFINITE_SHELL_VARIABLES.has(name)) {
      mentions.push({ start, end, name });
    }
    start = end - 1;
  }
  return mentions;
}

export function resolveSkillMentions(
  text: string,
  catalog: readonly SkillRef[],
  boundMentions: readonly BoundSkillMention[] = [],
): ResolvedMentions {
  const byName = new Map<string, SkillRef[]>();
  const byPath = new Map(catalog.map((skill) => [skill.path, skill]));
  for (const skill of catalog) {
    const sameName = byName.get(skill.name) ?? [];
    sameName.push(skill);
    byName.set(skill.name, sameName);
  }

  const boundByRange = new Map(
    boundMentions.map((binding) => [`${binding.start}:${binding.end}:${binding.name}`, binding]),
  );
  const resolved = new Map<string, SkillRef>();
  const ambiguous = new Set<string>();

  for (const mention of findSkillMentions(text)) {
    const bound = boundByRange.get(`${mention.start}:${mention.end}:${mention.name}`);
    if (bound) {
      const exact = byPath.get(bound.path);
      if (exact && exact.name === mention.name) resolved.set(exact.path, exact);
      continue;
    }

    const candidates = byName.get(mention.name) ?? [];
    if (candidates.length === 1) {
      resolved.set(candidates[0].path, candidates[0]);
    } else if (candidates.length > 1) {
      ambiguous.add(mention.name);
    }
  }

  return { skills: [...resolved.values()], ambiguousNames: [...ambiguous] };
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end--;
  return { value: value.slice(0, end), truncated: true };
}

export async function loadSkill(
  skill: SkillRef,
  load: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<LoadedSkill> {
  const name = truncateUtf8(skill.name, MAX_SKILL_NAME_BYTES).value;
  const path = truncateUtf8(skill.path, MAX_SKILL_PATH_BYTES).value;
  const contents = await load(skill.path);
  return { name, path, contents };
}

function escapeXmlText(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[character] ?? character);
}

/** Exact Codex fragment shape: name + path + the complete raw SKILL.md. */
export function renderSkillInstructions(skill: LoadedSkill): string {
  return `<skill>\n<name>${escapeXmlText(skill.name)}</name>\n<path>${escapeXmlText(skill.path)}</path>\n${skill.contents}\n</skill>`;
}
