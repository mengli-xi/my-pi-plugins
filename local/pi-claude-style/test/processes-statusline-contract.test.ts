import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BTW_PENDING_LINE,
  createBtwStatus,
  publishSideStatus,
  withdrawSideStatus,
} from "../../pi-side-chat/statusline.ts";
import {
  PROCESSES_OPEN_REQUEST_CHANNEL,
  PROCESSES_SNAPSHOT_REQUEST_CHANNEL,
  PROCESSES_STATUS_SNAPSHOT_CHANNEL,
  STATUS_LINE_ROW_CHANNEL,
} from "../src/integration-contracts.ts";
import { ContributedRows } from "../src/statusline/extra-lines.ts";

class ContractBus {
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  on(channel: string, handler: (payload: unknown) => void): () => void {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  emit(channel: string, payload: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

for (const order of ["host-first", "owner-first"] as const) {
  test(`Side Chat contribution composes on row three when ${order}`, () => {
    const bus = new ContractBus();
    const starts: Array<() => void> = [];
    const rows = new ContributedRows();
    const widgets: Array<string[] | undefined> = [];
    const registerHost = () => {
      bus.on(STATUS_LINE_ROW_CHANNEL, (payload) => rows.handle(payload));
    };
    const registerOwner = () => {
      starts.push(() => {
        publishSideStatus(
          { events: bus } as never,
          {
            ui: {
              theme: { fg: (_color: string, text: string) => text },
              setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
            },
          } as never,
          { status: "pending" },
        );
      });
    };

    for (const register of order === "host-first"
      ? [registerHost, registerOwner]
      : [registerOwner, registerHost]) register();
    for (const start of starts) start();

    assert.deepEqual(
      rows.spliceInline(["project", "model", "todo"]).lines,
      ["project", "model", "todo │ Side · ephemeral · cache pending"],
    );
    assert.equal(widgets.at(-1), undefined, "accepted statusline rows remove the fallback widget");

    withdrawSideStatus({ events: bus } as never, undefined);
    assert.deepEqual(rows.spliceInline(["project", "model", "todo"]).lines, ["project", "model", "todo"]);
  });
}

test("the Side and BTW segments share row three and withdraw independently", () => {
  const bus = new ContractBus();
  const rows = new ContributedRows();
  bus.on(STATUS_LINE_ROW_CHANNEL, (payload) => rows.handle(payload));
  const statuses: Array<string | undefined> = [];
  const ctx = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: () => undefined,
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as never;
  const commandRows = ["project", "model", "todo"];

  publishSideStatus({ events: bus } as never, ctx, { status: "pending" });
  const btw = createBtwStatus({ events: bus } as never);
  btw.show(ctx);

  assert.deepEqual(rows.spliceInline(commandRows).lines, [
    "project",
    "model",
    `todo │ Side · ephemeral · cache pending │ ${BTW_PENDING_LINE}`,
  ]);
  assert.equal(BTW_PENDING_LINE.includes("/btw cancel"), true, "the pending row keeps the cancel entry point");
  assert.deepEqual(statuses, [undefined],
    "a taken row leaves no second copy in the native status the CC Style footer never draws");

  btw.clear(ctx);
  assert.deepEqual(rows.spliceInline(commandRows).lines, [
    "project",
    "model",
    "todo │ Side · ephemeral · cache pending",
  ], "withdrawing BTW keeps the Side segment, so the two keys are separate producers");

  withdrawSideStatus({ events: bus } as never, undefined);
  assert.deepEqual(rows.spliceInline(commandRows).lines, commandRows);
});

function productionTypeScriptFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", "test", "tests"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...productionTypeScriptFiles(path));
    else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) result.push(path);
  }
  return result;
}

test("process owner and CC Style consumer share the exact v2 channels", () => {
  const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
  const ownerSource = readFileSync(join(dirname(workspace), "pi-processes/src/integrations/status-protocol.ts"), "utf8");
  const ownerChannels = Object.fromEntries(
    [...ownerSource.matchAll(/export const (PROCESSES_[A-Z_]+_CHANNEL) = "([^"]+)";/g)]
      .map((match) => [match[1], match[2]]),
  );

  assert.equal(ownerChannels.PROCESSES_STATUS_SNAPSHOT_CHANNEL, PROCESSES_STATUS_SNAPSHOT_CHANNEL);
  assert.equal(ownerChannels.PROCESSES_SNAPSHOT_REQUEST_CHANNEL, PROCESSES_SNAPSHOT_REQUEST_CHANNEL);
  assert.equal(ownerChannels.PROCESSES_OPEN_REQUEST_CHANNEL, PROCESSES_OPEN_REQUEST_CHANNEL);
  assert.equal(PROCESSES_STATUS_SNAPSHOT_CHANNEL.endsWith("-v2"), true);
});

test("CC Style is the only target-architecture processes row producer", () => {
  const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = productionTypeScriptFiles(dirname(workspace)).filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes("key: STATUS_LINE_PROCESSES_ROW_KEY");
  });

  assert.deepEqual(
    candidates.map((path) => path.slice(dirname(workspace).length + 1)),
    ["pi-claude-style/src/statusline/processes.ts"],
  );
});
