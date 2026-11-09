import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const TERMINAL_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

/** Display path for Edit style: cwd-relative when contained, otherwise absolute. */
export function displayEditPath(filePath: string, cwd?: string): string {
  const path = sanitizeDisplayPath(filePath);
  if (!path) return "";
  const root = typeof cwd === "string" ? sanitizeDisplayPath(cwd) : "";
  if (!root) return isAbsolute(path) ? resolve(path) : path;
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel) return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`)) return absolute;
  return rel;
}

function sanitizeDisplayPath(value: string): string {
  const cleaned = stripTerminalSequences(value)
    .replace(TERMINAL_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "~") return homedir();
  if (cleaned.startsWith(`~${sep}`)) return `${homedir()}${cleaned.slice(1)}`;
  return cleaned;
}
