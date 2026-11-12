import childProcess from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function descendants(pid) {
  if (!pid) return [];
  const result = childProcess.spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
  });
  const found = result.stdout?.trim();
  return found ? found.split(/\s+/).flatMap((value) => [Number(value), ...descendants(Number(value))]) : [];
}

// 清理失败只报告，不覆盖测量原先的异常；各项清理互不阻断。
export function cleanupMeasurement(job) {
  const attempt = (label, action) => {
    try {
      action();
    } catch (error) {
      console.error(`基准清理失败（${label}）：${error}`);
    }
  };
  try {
    attempt("socket server", () => job.server?.close());
    const pids = new Set(job.pids ?? []);
    attempt("后代快照", () => {
      for (const pid of descendants(job.child?.pid)) pids.add(pid);
    });
    if (job.child?.exitCode === null) {
      attempt("宿主退出", () => job.child.kill("SIGKILL"));
    }
    for (const pid of [...pids].reverse()) {
      try {
        const current = childProcess.spawnSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 5000,
        });
        // 快照中的 PID 可能已复用；无法核对命令行时也跳过。
        if (current.status !== 0 || !current.stdout?.includes(job.root)) continue;
        process.kill(pid, "SIGKILL");
      } catch {
        // PID 可能已经退出或不可操作，继续清理本次目录。
      }
    }
    attempt("路径匹配进程", () => childProcess.spawnSync("pkill", ["-f", `${job.root}/`], { timeout: 5000 }));
    attempt("PTY", () => {
      job.child?.terminal.close();
      if (job.child && !job.child.terminal.closed) console.error("基准 PTY 未关闭");
    });
    for (const socket of job.sockets ?? []) attempt("socket", () => socket.destroy());
    attempt("原始指标", () =>
      writeFileSync(join(job.artifacts, "metrics.jsonl"), readFileSync(join(job.root, "metrics.jsonl"))),
    );
    attempt("终端日志", () => writeFileSync(join(job.artifacts, "terminal-tail.txt"), job.raw ?? ""));
    attempt("错误日志", () => writeFileSync(join(job.artifacts, "stderr.txt"), job.stderr ?? ""));
  } finally {
    attempt("临时目录", () => rmSync(job.root, { recursive: true, force: true }));
  }
}
