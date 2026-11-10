import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const [cc, i18n] of [["none", "absent"], ["before", "absent"], ["after", "installed"]] as const) {
  test(`real Ask with ${cc === "none" ? "no CC" : `compiled CC ${cc}`} and i18n SDK ${i18n} preserves questionnaire and receipt semantics without Perf`, { timeout: 90000 }, () => {
    run("questionnaire.mjs", { ASK_CC: cc, ASK_I18N: i18n });
  });
}

test("real SDK and CLI respect explicit tool selection; print cannot wait for an Ask UI", { timeout: 90000 }, () => {
  run("selection.mjs");
});

function run(fixture: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ask-integration-"));
  for (const name of ["home", "agent", "config", "cache", "data", "state", "tmp", "cwd"]) mkdirSync(join(root, name));
  try {
    const output = execFileSync(process.execPath, [new URL(`./ask/fixtures/${fixture}`, import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 80000,
      env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp"), PI_OFFLINE: "1", TERM: "xterm-256color", LANG: "en_US.UTF-8", LC_ALL: "C",
        ASK_TEST_ROOT: root, ...extra },
    });
    assert.match(output, /ASK_INTEGRATION_OK/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
