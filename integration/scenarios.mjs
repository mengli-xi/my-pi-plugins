// 根 integration 的唯一场景清单；定向入口只过滤 tags，不再各自拼 glob。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../scripts/pi-checks.mjs";

// 每个场景声明实际使用的生产产物；runner 只构建所选集合的并集。
const defaultBuilds = {
  "ask.test.ts": ["pi-claude-style"],
  "degradation.test.ts": [],
  "fast-child-factories.test.ts": ["pi-subagents", "pi-processes"],
  "fast-statusline.test.ts": ["pi-claude-style"],
  "mcp-mailbox.test.ts": ["pi-claude-style", "@narumitw/pi-goal"],
  "mcp-task.test.ts": ["pi-claude-style", "@narumitw/pi-goal"],
  "processes-compact.test.ts": ["pi-processes"],
  "processes-subagents.test.ts": ["pi-processes"],
  "repository-e2e.test.ts": ["pi-subagents"],
  "search.test.ts": ["pi-claude-style", "pi-subagents"],
  "side-chat-bash-timeout.test.ts": [],
  "side-chat-processes.test.ts": ["pi-processes"],
  "skills-compact.test.ts": [],
  "skills-presentation.test.ts": ["pi-claude-style"],
};

export function requiredBuilds(suites) {
  return [...new Set(suites.flatMap(suite => suite.builds))].sort();
}

const nodeTest = ["node", "--import", "./ts-resolve.mjs", "--experimental-transform-types", "--test", "--test-timeout=300000"];
export function integrationScenarios(root = repositoryRoot) {
  const tests = readdirSync(join(root, "integration")).filter(file => file.endsWith(".test.ts")).sort().map(file => {
    if (!Object.hasOwn(defaultBuilds, file)) throw new Error(`场景须声明构建依赖：${file}`);
    return {
      id: file, tags: ["default", ...["ask", "mcp", "search"].filter(tag => file.startsWith(tag))],
      command: [...nodeTest, `integration/${file}`], builds: defaultBuilds[file],
    };
  });
  const subagents = readdirSync(join(root, "integration/subagents/real")).filter(file => file.endsWith(".test.ts")).sort().map(file => ({
    id: `subagents/${file}`, tags: ["subagents"], cwd: "local/pi-subagents",
    builds: ["pi-subagents", ...(["bash-timeout-child-e2e.test.ts", "web-search-child-e2e.test.ts", "mailbox-cold-recovery-e2e.test.ts"].includes(file) ? [] : ["pi-processes"]),
      ...(["mailbox-joint-e2e.test.ts", "mailbox-triple-e2e.test.ts"].includes(file) ? ["@narumitw/pi-goal"] : []),
      ...(file === "full-settings-spawn.test.ts" ? ["pi-claude-style"] : [])],
    command: ["node", "--import", join(root, "ts-resolve.mjs"), "--experimental-transform-types", "--test", "--test-timeout=300000", join(root, "integration/subagents/real", file)],
  }));
  return [...tests, ...subagents,
    { id: "side-chat/cc", builds: ["pi-claude-style"], tags: ["side-chat"], command: ["bun", "integration/side-chat/sdk-view-e2e.mjs"], requires: ["pty"] },
    { id: "side-chat/native", builds: [], tags: ["side-chat"], command: ["bun", "integration/side-chat/sdk-view-e2e.mjs"], env: { PI_S2_NATIVE_PRESENTATION: "1" }, requires: ["pty"] },
    { id: "patched-host", builds: ["pi-subagents"], tags: ["patched-host"], stock: false, command: ["node", "integration/run-patched-host.mjs"], requires: ["pty"] },
    { id: "stock-host", builds: ["pi-subagents"], tags: ["stock-host"], command: ["bun", "integration/subagent-no-presentation.mjs"], requires: ["pty"] },
    { id: "goal/ui", builds: ["@narumitw/pi-goal", "pi-claude-style"], tags: ["goal-ui"], command: ["bun", "integration/goal/ui-e2e.mjs"], requires: ["pty"] },
    { id: "goal/joint", builds: ["@narumitw/pi-goal", "pi-subagents", "pi-processes"], tags: ["goal"], command: ["node", "integration/goal/mailbox-a1-matrix.mjs", "$TMPDIR/goal-joint"] },
    { id: "goal/joint-reverse", builds: ["@narumitw/pi-goal", "pi-subagents", "pi-processes"], tags: ["goal"], command: ["node", "integration/goal/mailbox-a1-matrix.mjs", "$TMPDIR/goal-reverse"], env: { GOAL_JOINT_REVERSE: "1" } },
    { id: "processes/goal", builds: ["@narumitw/pi-goal", "pi-processes"], tags: ["goal"], command: ["node", "integration/processes/goal-process.mjs"] },
    { id: "inject/goal-followup", builds: ["@narumitw/pi-goal"], tags: ["goal"], command: ["node", "local/pi-session-inject/test/native/followup.mjs"], env: { MAILBOX_GOAL_ONLY: "1", MAILBOX_GOAL_BUNDLE: join(root, "fork/pi-goal/dist/index.js") } },
    { id: "cc/child-ui", builds: ["pi-claude-style"], tags: ["cc"], command: ["bun", "integration/claude-style/child-ui.mjs"], requires: ["pty"] },
    { id: "cc/context-compact", builds: ["pi-claude-style"], tags: ["cc"], command: ["bun", "integration/claude-style/context-compact.mjs"], requires: ["pty"] },
  ].map(suite => ({ timeoutMs: 300_000, ...suite }));
}

export function selectScenarios(scenarios, tag) {
  const selected = tag === "all" ? scenarios.filter(suite => suite.stock !== false) : scenarios.filter(suite => suite.tags.includes(tag));
  if (!selected.length) throw new Error(`未知或空 integration 场景组：${tag}`);
  return selected;
}
