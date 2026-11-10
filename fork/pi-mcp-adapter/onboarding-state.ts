import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { canonicalJson, createFileReader } from "./file-version-cache.ts";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";

export interface McpOnboardingState {
  version: 1;
  sharedConfigHintShown: boolean;
  setupCompleted: boolean;
  lastDiscoveryFingerprint?: string;
  /** Servers already asked whether to import Pi's sign-in, by name and normalized URL. */
  piSignInImportsAsked?: { server: string; url: string }[];
  /** Adapter version that last turned off, or found configured, Pi's built-in MCP. */
  piBuiltinMcpHandledVersion?: string;
}

const DEFAULT_STATE: McpOnboardingState = {
  version: 1,
  sharedConfigHintShown: false,
  setupCompleted: false,
};

export function getOnboardingStatePath(): string {
  return getAgentPath("mcp-onboarding.json");
}

const readOnboardingFile = createFileReader((text): McpOnboardingState => {
  const raw = JSON.parse(text) as Partial<McpOnboardingState>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) throw new Error("invalid onboarding state format");
  return {
    version: 1,
    sharedConfigHintShown: raw.sharedConfigHintShown === true,
    setupCompleted: raw.setupCompleted === true,
    ...(typeof raw.lastDiscoveryFingerprint === "string"
      ? { lastDiscoveryFingerprint: raw.lastDiscoveryFingerprint }
      : {}),
    ...(Array.isArray(raw.piSignInImportsAsked)
      ? {
          piSignInImportsAsked: raw.piSignInImportsAsked.filter((entry): entry is { server: string; url: string } =>
            typeof entry?.server === "string" && typeof entry.url === "string"),
        }
      : {}),
    ...(typeof raw.piBuiltinMcpHandledVersion === "string"
      ? { piBuiltinMcpHandledVersion: raw.piBuiltinMcpHandledVersion }
      : {}),
  };
});

export function loadOnboardingState(): McpOnboardingState {
  return structuredClone(readOnboardingFile(getOnboardingStatePath()).value ?? DEFAULT_STATE);
}

export function saveOnboardingState(state: McpOnboardingState): void {
  const path = getOnboardingStatePath();
  const current = readOnboardingFile(path);
  if (current.exists && canonicalJson(current.value) === canonicalJson(state)) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

export function updateOnboardingState(updater: (state: McpOnboardingState) => McpOnboardingState): McpOnboardingState {
  const next = updater(loadOnboardingState());
  saveOnboardingState(next);
  return next;
}

export function markSharedConfigHintShown(fingerprint?: string): McpOnboardingState {
  return updateOnboardingState((state) => {
    const lastDiscoveryFingerprint = fingerprint ?? state.lastDiscoveryFingerprint;
    return {
      ...state,
      sharedConfigHintShown: true,
      ...(lastDiscoveryFingerprint !== undefined ? { lastDiscoveryFingerprint } : {}),
    };
  });
}

export function markSetupCompleted(fingerprint?: string): McpOnboardingState {
  return updateOnboardingState((state) => {
    const lastDiscoveryFingerprint = fingerprint ?? state.lastDiscoveryFingerprint;
    return {
      ...state,
      setupCompleted: true,
      ...(lastDiscoveryFingerprint !== undefined ? { lastDiscoveryFingerprint } : {}),
    };
  });
}

export function markPiSignInImportAsked(server: string, url: string): McpOnboardingState {
  return updateOnboardingState((state) => ({
    ...state,
    piSignInImportsAsked: [...(state.piSignInImportsAsked ?? []), { server, url }],
  }));
}
