// Bun 管理 PTY，被测 Pi 始终使用 Node。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, totalmem, platform, release, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnvironment, installedPiVersion, repositoryRoot, workspacePackages, readJson } from "../pi-checks.mjs";
import { cleanupMeasurement, descendants } from "./cleanup.mjs";
import { summarize } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const options = {
  suite: "all",
  repetitions: 10,
  rounds: 1000,
  idleSeconds: 600,
  replyBlocks: 24,
  toolLines: 32,
  output: resolve(".perf-baseline", new Date().toISOString().replaceAll(":", "-")),
  only: "",
  bundled: false,
  git: false,
  sessionSource: "",
  traceOnly: false,
};
const flags = {
  "--bundled": "bundled",
  "--git": "git",
  "--trace-only": "traceOnly",
};
const values = {
  "--suite": "suite",
  "--repetitions": "repetitions",
  "--rounds": "rounds",
  "--idle-seconds": "idleSeconds",
  "--output": "output",
  "--only": "only",
  "--reply-blocks": "replyBlocks",
  "--tool-lines": "toolLines",
  "--session-source": "sessionSource",
};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (Object.hasOwn(flags, key)) {
    options[flags[key]] = true;
    continue;
  }
  const name = Object.hasOwn(values, key) ? values[key] : undefined;
  const value = process.argv[++i];
  assert.ok(name && value !== undefined && !value.startsWith("--"), `未知或缺少值的参数：${key}`);
  options[name] = typeof options[name] === "number" ? Number(value) : value;
}
assert.ok(["all", "cold", "long", "idle", "profile", "smoke", "resume"].includes(options.suite), "未知 suite");
for (const key of ["repetitions", "rounds", "idleSeconds", "replyBlocks", "toolLines"]) {
  assert.ok(Number.isInteger(options[key]) && options[key] > 0, `${key} 必须为正整数`);
}
assert.ok(options.rounds <= 5000, "轮数超出 faux 响应预算");
assert.ok(options.replyBlocks <= 256 && options.toolLines <= 1000, "答复或工具输出超出模型限制");
assert.ok(
  !options.sessionSource || ["profile", "resume"].includes(options.suite),
  "--session-source 仅用于 profile/resume",
);
assert.ok(!options.traceOnly || options.suite === "long", "--trace-only 仅用于 long");
assert.ok(options.suite !== "resume" || options.sessionSource, "resume 需要 --session-source");
if (options.sessionSource) assert.ok(existsSync(options.sessionSource), "转录文件不存在");

// 各阶段独立限时、串行运行；编排进程把退出信号转发给当前阶段。
if (options.suite === "all") {
  assert.ok(!options.bundled, "--bundled 仅用于单阶段");
  const base = resolve(options.output);
  mkdirSync(base, { recursive: true });
  const index = { schemaVersion: 1, stages: [] };
  let stageChild;
  let interrupted;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      interrupted = signal;
      try {
        stageChild?.kill(signal);
      } catch (error) {
        console.error(`阶段信号转发失败：${error}`);
      }
    });
  }
  async function stage(name, suite, bundled = false, only = options.only, source = "", traceOnly = false) {
    if (interrupted) process.exit(interrupted === "SIGINT" ? 130 : 143);
    const directory = join(base, name);
    const args = [
      process.execPath,
      fileURLToPath(import.meta.url),
      "--suite",
      suite,
      "--output",
      directory,
      "--repetitions",
      String(options.repetitions),
      "--rounds",
      String(suite === "profile" && source ? 20 : options.rounds),
      "--idle-seconds",
      String(options.idleSeconds),
      "--reply-blocks",
      String(options.replyBlocks),
      "--tool-lines",
      String(options.toolLines),
      ...(only ? ["--only", only] : []),
      ...(bundled ? ["--bundled"] : []),
      ...(options.git ? ["--git"] : []),
      ...(source ? ["--session-source", source] : []),
      ...(traceOnly ? ["--trace-only"] : []),
    ];
    stageChild = Bun.spawn({
      cmd: ["perl", "-e", "alarm 2400; exec @ARGV", ...args],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const status = await stageChild.exited;
    stageChild = undefined;
    index.stages.push({ name, directory, status });
    writeFileSync(join(base, "index.json"), JSON.stringify(index, null, 2) + "\n");
    if (interrupted) process.exit(interrupted === "SIGINT" ? 130 : 143);
    if (status !== 0) process.exit(status || 1);
  }
  await stage("cold", "cold");
  await stage("bundled-cold", "cold", true);
  const histories = [];
  for (const config of options.only ? options.only.split(",") : ["none", "all"]) {
    const name = `long-${config.replaceAll(":", "-")}`;
    await stage(name, "long", false, config, "", true);
    const result = readJson(join(base, name, "results.json"));
    const source = join(base, name, result.runs[0].id, "session.jsonl");
    histories.push({ config, source });
    await stage(`resume-${config.replaceAll(":", "-")}`, "resume", false, config, source);
  }
  await stage("idle", "idle");
  for (const { config, source } of histories) {
    await stage(`profile-${config.replaceAll(":", "-")}`, "profile", false, config, source);
  }
  process.exit(0);
}
const node = process.env.PI_BENCH_NODE || spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
assert.ok(existsSync(node), "找不到 Node 可执行文件（可设置 PI_BENCH_NODE）");
const expectedPi = readJson(join(repositoryRoot, "package.json")).devDependencies["@earendil-works/pi-coding-agent"];
assert.equal(installedPiVersion(), expectedPi, "已安装 Pi 与根 devDeps 不一致");
const packages = workspacePackages(repositoryRoot);
const plugins = packages.filter((pkg) => pkg.pi?.extensions?.length);
for (const pkg of plugins)
  for (const entry of pkg.pi.extensions) {
    assert.ok(existsSync(resolve(repositoryRoot, pkg.directory, entry)), `请先构建：${pkg.name}/${entry}`);
  }
const configurations = [
  { name: "none", packages: [] },
  { name: "all", packages: plugins },
  ...plugins.map((pkg) => ({
    name: pkg.directory.split("/").at(-1),
    packages: [pkg],
  })),
];
function configuration(name) {
  if (name.startsWith("without:")) {
    assert.ok(
      plugins.some((pkg) => pkg.directory.split("/").at(-1) === name.slice(8)),
      `未知消融配置：${name}`,
    );
    return {
      name,
      packages: plugins.filter((pkg) => pkg.directory.split("/").at(-1) !== name.slice(8)),
    };
  }
  const result = configurations.find((c) => c.name === name);
  assert.ok(result, `未知配置：${name}`);
  return result;
}
const selected = options.only ? options.only.split(",").map(configuration) : undefined;
const out = resolve(options.output);
mkdirSync(out, { recursive: true });
const uptime = () => execFileSync("uptime", { encoding: "utf8" }).trim();
const report = {
  schemaVersion: 2,
  status: "running",
  options,
  machine: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0].model,
    cores: cpus().length,
    memoryBytes: totalmem(),
    node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
    bun: Bun.version,
    pi: installedPiVersion(),
    uptime: uptime(),
    load: loadavg(),
    at: new Date().toISOString(),
  },
  repositoryRoot,
  runs: [],
  failures: [],
};
console.log(JSON.stringify(report.machine));
const save = () => writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2) + "\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let serial = 0;
let active;
function cleanActive() {
  try {
    if (active) cleanupMeasurement(active);
  } finally {
    active = undefined;
  }
}
function saveSafely() {
  try {
    save();
  } catch (error) {
    console.error(`保存基准结果失败：${error}`);
  }
}
for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGALRM", 142],
]) {
  process.once(signal, () => {
    report.status = "interrupted";
    report.failures.push({ id: active?.id, error: `收到信号 ${signal}` });
    saveSafely();
    cleanActive();
    process.exit(status);
  });
}

async function measure(config, { rounds = 0, idleSeconds = 0, sessionSource, profile = false } = {}) {
  const id = `${String(++serial).padStart(3, "0")}-${config.name.replaceAll(":", "-")}${sessionSource ? "-resume" : ""}`;
  const artifacts = join(out, id);
  mkdirSync(artifacts);
  const root = realpathSync(mkdtempSync("/tmp/pi-bench-"));
  const job = { id, artifacts, root, sockets: new Set(), raw: "", stderr: "" };
  active = job;
  const events = [];
  const waiters = new Set();
  let failure;
  try {
    console.log(
      `${id} ${root}/ load=${loadavg()
        .map((n) => n.toFixed(2))
        .join("/")}`,
    );
    const metrics = join(root, "metrics.jsonl");
    writeFileSync(metrics, "");
    for (const dir of ["home", "agent", "cwd", "sessions", "config", "cache", "data", "state", "tmp", "bin"])
      mkdirSync(join(root, dir));
    // 服务管理器与桌面通知只命中本次 profile 的桩程序。
    for (const binary of ["launchctl", "systemctl", "osascript", "notify-send"]) {
      writeFileSync(join(root, "bin", binary), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
    }
    if (options.git)
      execFileSync("git", ["init", "--quiet", join(root, "cwd")], {
        env: checkEnvironment(root),
        timeout: 30000,
      });
    const session = join(root, "sessions", "main.jsonl");
    let priorReadResults = 0;
    let priorUsers = 0;
    if (sessionSource) {
      const lines = readFileSync(sessionSource, "utf8").trimEnd().split("\n");
      const entries = lines.map(JSON.parse);
      const header = entries[0];
      assert.ok(header?.type === "session" && typeof header.id === "string", "缺少 Pi 会话头");
      priorReadResults = entries.filter(
        (e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "read",
      ).length;
      priorUsers = entries.filter((e) => e.type === "message" && e.message.role === "user").length;
      // 只重定位已删除的临时 cwd，保留全部消息与 entry ID。
      header.cwd = join(root, "cwd");
      lines[0] = JSON.stringify(header);
      writeFileSync(session, lines.join("\n") + "\n");
    }
    const fixtureText = "Local fixture output: abcdefghijklmnopqrstuvwxyz\n".repeat(options.toolLines);
    writeFileSync(join(root, "cwd", "fixture.txt"), fixtureText);
    writeFileSync(
      join(root, "agent", "settings.json"),
      JSON.stringify({
        packages: config.packages.map((p) => resolve(repositoryRoot, p.directory)),
        extensions: ["-builtin:mcp"],
        quietStartup: true,
        retry: { enabled: false },
        cacheWarming: "off",
        compaction: { enabled: false },
      }),
    );
    const env = checkEnvironment(root, {
      PATH: `${join(root, "bin")}:${dirname(node)}:${process.env.PATH}`,
      PI_BENCH_METRICS: metrics,
      PI_BENCH_SOCKET: join(root, "metrics.sock"),
      PI_BENCH_TIMERS: idleSeconds ? "1" : "0",
      PI_BENCH_REPLY_BLOCKS: String(options.replyBlocks),
      PI_BENCH_FIXTURE_BYTES: String(Buffer.byteLength(fixtureText)),
      PI_NEXT_AGENT_DIR: join(root, "agent"),
      PI_SCHEDULER_BINARY: resolve(repositoryRoot, "node_modules/.bin/pi"),
    });
    const cli = resolve(
      repositoryRoot,
      `node_modules/@earendil-works/pi-coding-agent/dist/${options.bundled ? "bundle/" : ""}cli.js`,
    );
    const args = [
      node,
      ...(!options.bundled ? ["--import", join(here, "instrument.mjs")] : []),
      ...(profile ? ["--cpu-prof", "--heap-prof", `--cpu-prof-dir=${artifacts}`, `--heap-prof-dir=${artifacts}`] : []),
      cli,
      "--offline",
      "--tui-mode",
      "regular",
      "--session",
      session,
      "--provider",
      "bench-faux",
      "--model",
      "bench",
      "--thinking",
      "off",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "-e",
      join(here, "probe.mjs"),
    ];
    job.server = createServer((socket) => {
      job.sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("close", () => job.sockets.delete(socket));
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf("\n")) >= 0; ) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            events.push(event);
            if (event.type === "error") failure = new Error(JSON.stringify(event));
          } catch (error) {
            failure = error;
          }
        }
        for (const wake of [...waiters]) wake();
      });
    });
    await new Promise((resolve, reject) => {
      job.server.once("error", reject);
      job.server.listen(env.PI_BENCH_SOCKET, resolve);
    });
    const start = performance.now();
    const child = (job.child = Bun.spawn({
      cmd: args,
      cwd: join(root, "cwd"),
      env,
      stdin: "ignore",
      stderr: "pipe",
      terminal: {
        cols: 112,
        rows: 38,
        data(_terminal, bytes) {
          job.raw = (job.raw + Buffer.from(bytes).toString()).slice(-200000);
        },
      },
    }));
    const stderr = new Response(child.stderr).text().then(
      (text) => {
        job.stderr = text;
      },
      (error) => {
        job.stderr = String(error);
      },
    );
    child.exited.then(() => {
      for (const wake of [...waiters]) wake();
    });
    const send = (text) => child.terminal.write(text + "\r");
    function wait(type, after = 0, timeout = 120000) {
      return new Promise((resolve, reject) => {
        const finish = (error, value) => {
          clearTimeout(timer);
          waiters.delete(check);
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error(`等待超时：${type}\n${job.raw}`)), timeout);
        const check = () => {
          if (failure) return finish(failure);
          const event = events.slice(after).find((e) => e.type === type);
          if (event) return finish(null, event);
          if (child.exitCode !== null) finish(new Error(`Pi 提前退出（${child.exitCode}）：${type}`));
        };
        waiters.add(check);
        check();
      });
    }
    const result = {
      id,
      configuration: config.name,
      cli,
      instrumented: !options.bundled,
      profile,
      root,
      loadBefore: loadavg(),
      rounds: [],
      idle: [],
      resumesFrom: sessionSource,
    };
    await wait("session-started");
    send("/bench-ready");
    result.ready = await wait("ready");
    result.readyMs = performance.now() - start;
    assert.equal(result.ready.mode, "tui", "宿主必须为 TUI 模式");
    if (sessionSource) assert.equal(result.ready.userMessages, priorUsers, "恢复的用户消息数不完整");
    if (!options.bundled) {
      for (const pkg of config.packages)
        for (const entry of pkg.pi.extensions) {
          assert.ok(
            result.ready.imports.some((item) => item.path === resolve(repositoryRoot, pkg.directory, entry)),
            `未加载：${pkg.name}/${entry}`,
          );
        }
      for (const hook of [
        "import",
        "factory",
        "handler",
        "loadErrors",
        "requestRender",
        "TuiMainScreen",
        "settledBoundary",
      ]) {
        assert.ok(result.ready.hooks.includes(hook), `缺少计时钩子：${hook}`);
      }
    }
    for (let round = 1; round <= rounds; round++) {
      const after = events.length;
      send(`BENCH_ROUND_${round}`);
      const settled = await wait("settled", after);
      assert.equal(settled.round, round, "收到的轮次不匹配");
      // 排空最终合并帧；40ms 不计入 input→settled 业务耗时。
      await delay(40);
      const sampleAfter = events.length;
      send("/bench-sample");
      const sample = await wait("sample", sampleAfter);
      result.rounds.push({ ...settled, ...sample });
      if ([1, 200, 500, 1000, rounds].includes(round)) {
        console.log(
          `${id} round=${round} ms=${settled.elapsedMs.toFixed(1)} rssMiB=${(sample.memory.rss / 1048576).toFixed(1)}`,
        );
        writeFileSync(join(artifacts, `session-${round}.jsonl`), readFileSync(session));
      }
    }
    for (let seconds = 0; seconds < idleSeconds; ) {
      const interval = Math.min(30, idleSeconds - seconds);
      await delay(interval * 1000);
      seconds += interval;
      const after = events.length;
      send("/bench-sample");
      result.idle.push(await wait("sample", after));
    }
    result.loadAfter = loadavg();
    if (rounds) {
      const entries = readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(
        entries.filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "read")
          .length,
        priorReadResults + rounds,
        "每轮必须执行一次真实 read",
      );
    }
    job.pids = descendants(child.pid);
    send("/bench-quit");
    let quitTimer;
    try {
      await Promise.race([
        child.exited,
        new Promise((_, reject) => {
          quitTimer = setTimeout(() => reject(new Error("优雅退出超时")), 15000);
        }),
      ]);
    } finally {
      clearTimeout(quitTimer);
    }
    await stderr;
    assert.equal(child.exitCode, 0, job.stderr);
    // 退出阶段的错误也以原始日志为准，避免遗漏尚未排空的 socket 消息。
    const errors = readFileSync(metrics, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((e) => e.type === "error");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    writeFileSync(join(artifacts, "session.jsonl"), existsSync(session) ? readFileSync(session) : "");
    result.roundSummary = summarize(result.rounds.map((r) => r.elapsedMs));
    report.runs.push(result);
    save();
    return artifacts;
  } catch (error) {
    report.failures.push({
      id,
      error: String(error),
      events: events.slice(-3),
    });
    saveSafely();
    throw error;
  } finally {
    cleanActive();
  }
}
try {
  const configs = selected ?? (options.suite === "cold" ? configurations : configurations.slice(0, 2));
  if (options.suite === "cold") {
    // 交错采样，减轻机器负载随时间漂移的影响。
    for (let repeat = 0; repeat < options.repetitions; repeat++) for (const config of configs) await measure(config);
    report.coldSummary = Object.fromEntries(
      configs.map((config) => [
        config.name,
        summarize(report.runs.filter((r) => r.configuration === config.name).map((r) => r.readyMs)),
      ]),
    );
  } else {
    for (const config of configs) {
      const { suite } = options;
      let artifact;
      if (suite !== "resume") {
        artifact = await measure(config, {
          rounds: suite === "smoke" ? 3 : ["long", "profile"].includes(suite) ? options.rounds : 0,
          idleSeconds: suite === "idle" ? options.idleSeconds : 0,
          profile: suite === "profile",
          sessionSource: options.sessionSource || undefined,
        });
      }
      if (suite === "smoke")
        await measure(config, {
          sessionSource: join(artifact, "session.jsonl"),
        });
      const sourceDir = suite === "resume" ? dirname(options.sessionSource) : artifact;
      const checkpoints =
        suite === "resume" || (suite === "long" && !options.traceOnly)
          ? [200, 500, 1000].filter((n) => n <= options.rounds)
          : [];
      for (const checkpoint of checkpoints)
        for (let repeat = 0; repeat < options.repetitions; repeat++) {
          await measure(config, {
            sessionSource: join(sourceDir, `session-${checkpoint}.jsonl`),
          });
        }
    }
  }
} catch (error) {
  if (!report.failures.length) report.failures.push({ error: String(error) });
  throw error;
} finally {
  report.status = report.failures.length ? "failed" : "completed";
  try {
    report.machine.uptimeAfter = uptime();
  } catch (error) {
    console.error(`读取最终负载失败：${error}`);
  }
  saveSafely();
  console.log(join(out, "results.json"));
}
execFileSync(node, [join(here, "analyze.mjs"), out], { stdio: "inherit" });
