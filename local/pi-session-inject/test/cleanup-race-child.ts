import assert from "node:assert/strict";
import { readlink } from "node:fs/promises";
import { MailboxStore } from "../src/mailbox-v1/store.js";

const [directory, rawIdentity, mode, rawPending] = process.argv.slice(2) as [string, string, string, string];
let attempts = 0;
const proceed = new Promise<void>(resolve => { process.once("message", () => resolve()); });
const store: MailboxStore = new MailboxStore(directory, JSON.parse(rawIdentity), { at: async point => {
  if (point === "before-lock") {
    attempts++;
    if (mode === "mkdir-before-rmdir" && attempts === 1) { process.send!({ stage: "before-lock" }); await proceed; }
  }
  if (point === "before-write") assert.equal(await readlink(store.lockPath), store.owner);
} });
await store.acquire(); await store.transact(draft => { draft.pending.push(JSON.parse(rawPending)); });
const close = new Promise<void>(resolve => { process.once("message", () => resolve()); });
process.send!({ stage: "written", attempts }); await close; await store.close(); process.disconnect();
