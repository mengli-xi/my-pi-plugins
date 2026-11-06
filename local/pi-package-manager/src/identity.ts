import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import type { PackageKind, PackageScope } from "./types.js";

function npmPackageName(source: string): string {
  const spec = source.slice("npm:".length);
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const versionAt = slash === -1 ? -1 : spec.indexOf("@", slash);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }

  const versionAt = spec.lastIndexOf("@");
  return versionAt <= 0 ? spec : spec.slice(0, versionAt);
}

function stripGitRef(source: string): string {
  const protocolIndex = source.indexOf("://");
  const pathStart = protocolIndex === -1
    ? source.indexOf(":")
    : source.indexOf("/", protocolIndex + 3);
  const refAt = source.lastIndexOf("@");
  return refAt > pathStart ? source.slice(0, refAt) : source;
}

function normalizeGitSource(source: string): string {
  let value = source.startsWith("git:") ? source.slice(4) : source;
  value = stripGitRef(value.trim());

  const scp = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !value.includes("://")) {
    value = `${scp[1]!.toLowerCase()}/${scp[2]}`;
  } else {
    try {
      const parsed = new URL(value.includes("://") ? value : `https://${value}`);
      value = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      // Keep shorthand sources as-is; normalization below is still useful.
    }
  }

  return value
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

export function packageKind(source: string): PackageKind {
  if (source.startsWith("npm:")) return "npm";
  if (
    source.startsWith("git:") ||
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    source.startsWith("ssh://") ||
    source.startsWith("git://") ||
    /^git@[^:]+:/.test(source)
  ) {
    return "git";
  }
  return "local";
}

export function packageIdentity(
  source: string,
  scope: PackageScope,
  cwd: string,
  agentDir: string,
): string {
  const kind = packageKind(source);
  if (kind === "npm") return `npm:${npmPackageName(source).toLowerCase()}`;
  if (kind === "git") return `git:${normalizeGitSource(source)}`;

  const base = scope === "project" ? join(cwd, CONFIG_DIR_NAME) : agentDir;
  const expanded = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
  return `local:${resolve(base, expanded)}`;
}

export function fallbackDisplayName(source: string): string {
  const kind = packageKind(source);
  if (kind === "npm") return npmPackageName(source);
  if (kind === "git") {
    const normalized = normalizeGitSource(source);
    return basename(normalized) || normalized;
  }
  return basename(source.replace(/\/$/, "")) || source;
}
