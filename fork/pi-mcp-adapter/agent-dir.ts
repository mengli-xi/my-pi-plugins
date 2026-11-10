import { CONFIG_DIR_NAME, getAgentDir as getRuntimeAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createFileReader } from "./file-version-cache.ts";

export function getConfigDirName(): string {
  return CONFIG_DIR_NAME;
}

export function getAgentDir(): string {
  return getRuntimeAgentDir();
}

export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}

const readManifest = createFileReader((text) => JSON.parse(text) as {
  piConfig?: { name?: unknown; clientUri?: unknown };
});

/**
 * Pi 1.5 exposes directory discovery, but not APP_NAME or the client URI at its
 * public root. Read only the manifest the public getPackageDir() reports; an
 * unavailable manifest supplies no rebranding metadata, never another install.
 */
function readPiConfig(): { name?: unknown; clientUri?: unknown } | undefined {
  return readManifest(join(getPackageDir(), "package.json")).value?.piConfig;
}

export function getAppName(): string {
  const name = readPiConfig()?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "pi";
}

export function getAppClientUri(): string | undefined {
  const uri = readPiConfig()?.clientUri;
  return typeof uri === "string" && uri.trim() ? uri.trim() : undefined;
}
