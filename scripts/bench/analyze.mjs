import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { repositoryRoot } from "../pi-checks.mjs";
import { summarize } from "./stats.mjs";

const roots = process.argv.slice(2).map((value) => resolve(value));
if (!roots.length) throw new Error("用法：node scripts/bench/analyze.mjs <结果目录> [...]");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
// 只认仓库根直属的包，忽略系统路径和包内 node_modules 的同名目录。
const owner = (path, repoRoot) => {
  if (!isAbsolute(path)) return "host/probe";
  return relative(repoRoot, path).match(/^(?:local|fork)\/([^/]+)\//)?.[1] ?? "host/probe";
};
const cpuMs = (cpu) => (cpu.user + cpu.system) / 1000;
const memory = (value) => ({
  rssMiB: value.rss / 1048576,
  heapUsedMiB: value.heapUsed / 1048576,
});
const sum = (values) => values.reduce((a, b) => a + b, 0);
const topFrames = (frames, field) => {
  const totals = new Map();
  for (const frame of frames) {
    const key = JSON.stringify([frame.url, frame.functionName, frame.lineNumber, frame.columnNumber]);
    const value = totals.get(key) ?? { ...frame, [field]: 0 };
    value[field] += frame[field];
    totals.set(key, value);
  }
  return [...totals.values()].sort((a, b) => b[field] - a[field]).slice(0, 30);
};
for (const root of roots) {
  const report = read(join(root, "results.json"));
  const repoRoot = report.repositoryRoot ?? repositoryRoot;
  const groups = {};
  for (const run of report.runs) (groups[run.configuration] ??= []).push(run);
  const output = {
    root,
    status: report.status ?? "unrecorded",
    machine: report.machine,
    failures: report.failures,
    groups: {},
    profiles: [],
  };
  for (const [name, runs] of Object.entries(groups)) {
    const cold = runs.filter((r) => !r.resumesFrom && !r.rounds.length && !r.idle.length);
    const activation = {};
    for (const run of cold) {
      const perRun = {};
      for (const [field, key] of [
        ["imports", "importMs"],
        ["factories", "factoryMs"],
      ])
        for (const entry of run.ready[field] ?? []) {
          const p = (perRun[owner(entry.path, repoRoot)] ??= {
            importMs: 0,
            factoryMs: 0,
            sessionStartMs: 0,
          });
          p[key] += entry.ms;
        }
      for (const [key, value] of Object.entries(run.ready.handlers ?? {}))
        if (key.endsWith(":session_start")) {
          const p = (perRun[owner(key, repoRoot)] ??= {
            importMs: 0,
            factoryMs: 0,
            sessionStartMs: 0,
          });
          p.sessionStartMs += value.ms;
        }
      for (const [pkg, values] of Object.entries(perRun)) {
        const samples = (activation[pkg] ??= {
          importMs: [],
          factoryMs: [],
          sessionStartMs: [],
        });
        for (const key of Object.keys(samples)) samples[key].push(values[key]);
      }
    }
    const long = runs
      .filter((r) => r.rounds.length)
      .map((run) => ({
        id: run.id,
        profile: run.profile,
        historyAtStart: run.ready.userMessages,
        readyMs: run.readyMs,
        startup: memory(run.ready.memory),
        windows: [
          [1, 100],
          [101, 200],
          [401, 500],
          [901, 1000],
        ]
          .map(([start, end]) => {
            const rounds = run.rounds.filter((r) => r.round >= start && r.round <= end);
            if (!rounds.length) return null;
            const handlers = {};
            const hasSyncTimings = rounds.every((r) =>
              Object.values(r.handlers ?? {}).every((v) => v.syncMs !== undefined),
            );
            let cycleCpuMs = 0,
              cycleWallMs = 0;
            for (const round of rounds) {
              const previous = round.round === 1 ? run.ready : run.rounds[round.round - 2];
              if (round.cycleCpuUs) {
                cycleCpuMs += cpuMs(round.cycleCpuUs);
                cycleWallMs += round.cycleWallMs;
              } else {
                // 保留旧数据的完整取样周期口径，供历史报告复核。
                cycleCpuMs += cpuMs(round.cpu) - cpuMs(previous.cpu);
                cycleWallMs += round.at - previous.at;
              }
            }
            for (const round of rounds)
              for (const [key, value] of Object.entries(round.handlers ?? {})) {
                const p = (handlers[owner(key, repoRoot)] ??= { ms: 0, syncMs: 0 });
                p.ms += value.ms;
                p.syncMs += value.syncMs ?? 0;
              }
            return {
              start,
              end: rounds.at(-1).round,
              historyRange: [run.ready.userMessages + start, run.ready.userMessages + rounds.at(-1).round],
              turnMs: summarize(rounds.map((r) => r.elapsedMs)),
              frameLatencyMs: summarize(rounds.flatMap((r) => r.frames ?? []).map((f) => f.latency)),
              frameWorkMs: summarize(rounds.flatMap((r) => r.frames ?? []).map((f) => f.ms)),
              renderMsPerRound: sum(rounds.map((r) => r.renderMs ?? 0)) / rounds.length,
              cpuMsPerRound: sum(rounds.map((r) => cpuMs(r.activeCpuUs))) / rounds.length,
              cpuPercentOneCore:
                (100 * sum(rounds.map((r) => cpuMs(r.activeCpuUs)))) / sum(rounds.map((r) => r.elapsedMs)),
              cycleCpuMsPerRound: cycleCpuMs / rounds.length,
              cycleCpuPercentOneCore: (100 * cycleCpuMs) / cycleWallMs,
              finalMemory: memory(rounds.at(-1).memory),
              handlersMsPerRound: Object.fromEntries(
                Object.entries(handlers).map(([p, v]) => [p, v.ms / rounds.length]),
              ),
              handlersSyncMsPerRound: hasSyncTimings
                ? Object.fromEntries(Object.entries(handlers).map(([p, v]) => [p, v.syncMs / rounds.length]))
                : null,
            };
          })
          .filter(Boolean),
      }));
    const idle = runs
      .filter((r) => r.idle.length)
      .map((run) => {
        const first = run.ready,
          last = run.idle.at(-1),
          wallMs = last.at - first.at;
        const timers = new Map();
        for (const timer of last.timers ?? []) {
          const before = (first.timers ?? []).find(
            (t) => t.name === timer.name && t.delay === timer.delay && t.stack === timer.stack,
          );
          const delay = typeof timer.delay === "number" ? Math.round(timer.delay) : timer.delay;
          const key = JSON.stringify([timer.name, delay, timer.stack]);
          const value = timers.get(key) ?? { ...timer, delay, calls: 0, ms: 0 };
          value.calls += timer.calls - (before?.calls ?? 0);
          value.ms += timer.ms - (before?.ms ?? 0);
          timers.set(key, value);
        }
        return {
          id: run.id,
          wallMs,
          cpuMs: cpuMs(last.cpu) - cpuMs(first.cpu),
          cpuPercentOneCore: (100 * (cpuMs(last.cpu) - cpuMs(first.cpu))) / wallMs,
          startMemory: memory(first.memory),
          endMemory: memory(last.memory),
          steady:
            run.idle.length > 1
              ? {
                  wallMs: last.at - run.idle[0].at,
                  cpuPercentOneCore: (100 * (cpuMs(last.cpu) - cpuMs(run.idle[0].cpu))) / (last.at - run.idle[0].at),
                  startMemory: memory(run.idle[0].memory),
                  endMemory: memory(last.memory),
                }
              : null,
          timers: [...timers.values()]
            .filter((t) => t.calls)
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 30),
          subprocesses: (last.subprocesses ?? [])
            .map((command) => {
              const before = (first.subprocesses ?? []).find((c) => c.command === command.command);
              return {
                ...command,
                launches: command.launches - (before?.launches ?? 0),
                completed: command.completed - (before?.completed ?? 0),
                wallMs: command.wallMs - (before?.wallMs ?? 0),
              };
            })
            .filter((c) => c.launches || c.completed),
        };
      });
    output.groups[name] = {
      coldMs: summarize(cold.map((r) => r.readyMs)),
      startupMemory: cold.length
        ? {
            rssMiB: summarize(cold.map((r) => memory(r.ready.memory).rssMiB)),
            heapUsedMiB: summarize(cold.map((r) => memory(r.ready.memory).heapUsedMiB)),
          }
        : null,
      activation: Object.fromEntries(
        Object.entries(activation).map(([pkg, values]) => [
          pkg,
          Object.fromEntries(Object.entries(values).map(([key, value]) => [key, summarize(value)])),
        ]),
      ),
      long,
      idle,
      interactions: Object.fromEntries([...new Set(runs.flatMap(run => (run.interactions ?? []).map(s => s.command)))].map(command => {
        const samples = runs.flatMap(run => run.interactions ?? []).filter(s => s.command === command);
        return [command, { readyMs: summarize(samples.map(s => s.elapsedMs)),
          chooserMs: summarize(samples.map(s => s.chooserMs ?? 0)) }];
      })),
      switches: Object.fromEntries(["new", "resume"].map(command => {
        const samples = runs.flatMap(run => run.switches ?? []).filter(sample => sample.command === command);
        return [command, {
          readyMs: summarize(samples.map(sample => sample.elapsedMs)),
          chooserMs: summarize(samples.map(sample => sample.chooserMs)),
          replacementMs: summarize(samples.map(sample => sample.replacement.elapsedMs)),
          renderMs: summarize(samples.map(sample => sample.ready?.renderMs ?? sample.replacement.renderMs)),
        }];
      })),
      resume: runs
        .filter((r) => r.resumesFrom && !r.switches)
        .map((r) => ({
          id: r.id,
          readyMs: r.readyMs,
          users: r.ready.userMessages,
          memory: memory(r.ready.memory),
        })),
    };
  }
  for (const directory of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of readdirSync(join(root, directory.name))) {
      if (file.endsWith(".cpuprofile")) {
        const profile = read(join(root, directory.name, file));
        const counts = new Map(),
          wholeCounts = new Map();
        const readyAt = report.runs.find((run) => run.id === directory.name)?.ready.at;
        // macOS 的 V8 与 uv 绝对时钟不同，按进程相对就绪时间近似切分。
        const ready = readyAt === undefined ? undefined : profile.startTime + readyAt * 1000;
        let at = profile.startTime;
        for (let i = 0; i < (profile.samples ?? []).length; i++) {
          const start = at;
          at += profile.timeDeltas[i];
          const id = profile.samples[i];
          wholeCounts.set(id, (wholeCounts.get(id) ?? 0) + profile.timeDeltas[i] / 1000);
          counts.set(id, (counts.get(id) ?? 0) + Math.max(0, at - Math.max(start, ready ?? start)) / 1000);
        }
        output.profiles.push({
          file: join(directory.name, file),
          kind: "sampled CPU self time",
          scope: ready === undefined ? "whole process" : "after approximate process-relative input-ready",
          top: topFrames(
            profile.nodes.map((n) => ({
              ...n.callFrame,
              ms: counts.get(n.id) ?? 0,
            })),
            "ms",
          ),
          wholeProcessTop: topFrames(
            profile.nodes.map((n) => ({
              ...n.callFrame,
              ms: wholeCounts.get(n.id) ?? 0,
            })),
            "ms",
          ),
        });
      }
      if (file.endsWith(".heapprofile")) {
        const profile = read(join(root, directory.name, file)),
          allocations = [];
        const walk = (node) => {
          allocations.push({ ...node.callFrame, bytes: node.selfSize });
          for (const child of node.children) walk(child);
        };
        walk(profile.head);
        output.profiles.push({
          file: join(directory.name, file),
          kind: "sampled allocation bytes (not retained heap)",
          top: topFrames(allocations, "bytes"),
        });
      }
    }
  }
  writeFileSync(join(root, "summary.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(join(root, "summary.json"));
}
