import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CapabilityEntryV1, ExecutionFactoryProofV1 } from "../persistence/types.js";

// Search's child.ts and Processes' child.js are wrappers, not the factories we
// execute. Freeze and check the direct factory file; this is not a sandbox or a
// claim that every transitive dependency has been frozen. Unknown targets fail
// closed in the execution catalog, never through a caller-supplied loader.
const FACTORIES = {
  "pi-native-search": { directory: "extensions", child: "child.ts", file: "index.ts", exports: ["createSearchChildFactory", "loadSearchConfig"] },
  "pi-processes": { directory: "dist", child: "child.js", file: "child-factory.js", exports: ["createProcessesChildFactory"] },
} as const;

function auditedFactory(owner: string, child: string) {
  const spec = FACTORIES[owner as keyof typeof FACTORIES];
  if (!spec) return undefined;
  if (basename(child) !== spec.child || basename(dirname(child)) !== spec.directory) throw new Error(`capability-unavailable: unknown SDK child target ${owner}: ${child}`);
  return { path: join(dirname(child), spec.file), exports: [...spec.exports] };
}

export async function captureExecutionFactoryV1(owner: string, child: string): Promise<ExecutionFactoryProofV1 | undefined> {
  const spec = auditedFactory(owner, child);
  if (!spec) return undefined;
  const path = await realpath(spec.path);
  if (path !== spec.path) throw new Error(`capability-unavailable: factory is not the direct audited target: ${owner}`);
  return { version: 1, canonical_path: path, sha256: createHash("sha256").update(await readFile(path)).digest("hex"), exports: spec.exports };
}

export async function revalidateExecutionFactoryV1(entry: CapabilityEntryV1): Promise<ExecutionFactoryProofV1> {
  const spec = auditedFactory(entry.owner, entry.child_entrypoint), proof = entry.execution_factory;
  if (!spec || !proof) throw new Error(`capability-unavailable: frozen execution factory proof is missing: ${entry.owner}; prepare a new profile`);
  if (proof.version !== 1 || proof.canonical_path !== spec.path || JSON.stringify(proof.exports) !== JSON.stringify(spec.exports)) throw new Error(`capability-unavailable: execution factory proof/entry mismatch: ${entry.owner}`);
  const current = await captureExecutionFactoryV1(entry.owner, entry.child_entrypoint);
  if (!current || current.sha256 !== proof.sha256) throw new Error(`capability-drift: execution factory changed: ${entry.owner}`);
  return proof;
}
