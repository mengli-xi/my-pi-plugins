import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { MailboxSessionIdentity, MailboxSnapshot } from "./types.js";
import type { MailboxStore, SnapshotDraft } from "./store.js";

import { snapshotPath } from "./paths.js";
export { canonicalAgentDir, snapshotPath } from "./paths.js";
/** An empty binding only probes its own directory. Writer code is imported for
 * recovery/cleanup or the first mutation, never for a fresh empty run. */
export class SlotStorage {
  readonly path: string;
  readonly agentDir: string;
  readonly identity: MailboxSessionIdentity;
  readonly onDiskSnapshot: ((snapshot: MailboxSnapshot) => void) | undefined;
  #snapshot: MailboxSnapshot;
  #opening: Promise<MailboxStore> | null = null;
  constructor(agentDir: string, identity: MailboxSessionIdentity, onDiskSnapshot?: (snapshot: MailboxSnapshot) => void) {
    this.agentDir = agentDir; this.identity = identity; this.path = snapshotPath(agentDir, identity.id);
    this.onDiskSnapshot = onDiskSnapshot;
    this.#snapshot = { version: 1, session: identity, revision: 0, suspended: null, pending: [], terminal: [] };
  }
  get snapshot(): MailboxSnapshot { return this.#snapshot; }
  async open(): Promise<MailboxStore> {
    if (!this.#opening) {
      const opening: Promise<MailboxStore> = import("./store.js").then(async ({ MailboxStore }) => {
        const store = new MailboxStore(this.agentDir, this.identity, undefined, this.onDiskSnapshot); await store.acquire();
        this.#snapshot = store.snapshot; return store;
      }).catch(error => {
        // Share only an in-flight attempt or its usable store. A failed open
        // owns no usable store and must not poison retries or later teardown.
        if (this.#opening === opening) this.#opening = null;
        throw error;
      });
      this.#opening = opening;
    }
    return this.#opening;
  }
  async acquire(): Promise<void> {
    if (!existsSync(dirname(this.path))) return;
    const store = await this.open();
    const snapshot = store.snapshot;
    if (!snapshot.pending.length && !snapshot.terminal.length && !snapshot.suspended && !snapshot.attempt) {
      try { await store.transact(() => {}); } finally { this.#snapshot = store.snapshot; }
    }
  }
  async transact<T>(edit: (draft: SnapshotDraft) => T): Promise<T> {
    const store = await this.open();
    try { return await store.transact(edit); } finally { this.#snapshot = store.snapshot; }
  }
  async barrier(): Promise<void> { if (this.#opening) await (await this.#opening).barrier(); }
  async close(): Promise<void> { if (this.#opening) await (await this.#opening).close(); }
}
