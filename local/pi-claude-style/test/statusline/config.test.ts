import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { clearConfigCache, readStatusLineConfig } from "../../src/statusline/config.ts";
import { runStatusLineCommand } from "../../src/statusline/command.ts";

function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cc-statusline-config-"));
  const agent = join(root, "agent");
  const cwd = join(root, "workspace with 'quotes'");
  mkdirSync(agent);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    clearConfigCache(cwd);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    cwd,
    global(statusLine: unknown) {
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ statusLine }));
      clearConfigCache(cwd);
    },
    project(statusLine: unknown) {
      writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ statusLine }));
      clearConfigCache(cwd);
    },
  };
}

test("missing command runs the package's built-in script with node from any cwd", async (t) => {
  const fixture = workspace(t);
  const config = readStatusLineConfig(fixture.cwd)!;
  assert.match(config.command, /^node '\/.*\/pi-claude-style\/assets\/statusline\.mjs'$/);
  assert.equal(config.placement, "footer");
  const lines = await runStatusLineCommand(config.command, { cwd: fixture.cwd } as never,
    fixture.cwd, new AbortController().signal, 5_000);
  assert.match(lines[0]!, /\[\[pi:slot:model\]\]/);
  assert.match(lines[1]!, /↑0.*↓0.*R:0.*W:0/);

  fixture.project({ placement: "widget", debounceMs: 0 });
  const placed = readStatusLineConfig(fixture.cwd)!;
  assert.equal(placed.command, config.command, "placement-only settings still use the default");
  assert.equal(placed.placement, "widget");
  assert.equal(placed.debounceMs, 0);
});

test("user commands override the built-in default and project settings override global", async (t) => {
  const fixture = workspace(t);
  fixture.global({ command: "printf 'global-user-command\\n'" });
  assert.equal(readStatusLineConfig(fixture.cwd)!.command, "printf 'global-user-command\\n'");
  fixture.project({ type: "command", command: "printf 'project-user-command\\n'" });
  const config = readStatusLineConfig(fixture.cwd)!;
  const lines = await runStatusLineCommand(config.command, {} as never,
    fixture.cwd, new AbortController().signal, 5_000);
  assert.deepEqual(lines, ["project-user-command"]);
});

test("explicit empty commands and non-command types keep statusline disabled", (t) => {
  const fixture = workspace(t);
  for (const statusLine of [{ type: "command", command: "" }, { command: null }, { type: "disabled" }]) {
    fixture.project(statusLine);
    assert.equal(readStatusLineConfig(fixture.cwd), null);
  }
});
