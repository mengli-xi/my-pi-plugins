#!/usr/bin/env node
import { TuiMainScreen, TuiAltScreen } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkEnvironment, installedPiVersion } from "../../../scripts/pi-checks.mjs";

function checkProbes(TuiMainScreen, TuiAltScreen) {
  const base = Object.getPrototypeOf(TuiMainScreen.prototype);
  const probes = [
    ["tui-base.requestRender", base, "requestRender"],
    ["tui-base.handleTerminalInput", base, "handleTerminalInput"],
    ["tui-main-screen.doRender", TuiMainScreen.prototype, "doRender"],
    ["tui-alt-screen.doRender", TuiAltScreen.prototype, "doRender"],
  ];
  let failed = false;
  for (const [id, target, member] of probes) {
    const descriptor = target && Object.getOwnPropertyDescriptor(target, member);
    const ok = typeof descriptor?.value === "function" && descriptor.writable === true;
    process.stdout.write(`${ok ? "OK" : "MISSING"} ${id}\n`);
    if (!ok) failed = true;
  }
  return !failed;
}
if (!process.argv.includes("--host")) {
  if (!checkProbes(TuiMainScreen, TuiAltScreen)) process.exitCode = 1;
} else {
  if (!process.env.PI_BIN) throw new Error("use check:host via the root runner");
  const directory = mkdtempSync(join(tmpdir(), "perf-host-"));
  try {
    for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(directory, name));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "pi-perf-host-probe", type: "module", pi: { extensions: ["./probe.ts"] } }));
    const extension = join(directory, "probe.ts");
    writeFileSync(extension, `import { TuiMainScreen, TuiAltScreen } from "@earendil-works/pi-tui";
import perf from ${JSON.stringify(resolve("index.ts"))};
export default function(pi) {
  if (!(${checkProbes.toString()})(TuiMainScreen, TuiAltScreen)) throw new Error("perf seam mismatch");
  perf(pi);
  pi.on("session_start", (_event, ctx) => {
    const registry = globalThis[Symbol.for("pi.perf.telemetry.v1")];
    if (!registry || registry.getStatus().enabled) throw new Error("fine-grained telemetry must default off");
    console.log("OK perf.default-low-frequency");
  });
}
`);
    const result = spawnSync(process.env.PI_BIN, ["-ne", "-e", directory, "--mode", "rpc", "--no-session", "--no-tools"], {
      env: checkEnvironment(directory), input: "", encoding: "utf8", timeout: 30_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(output);
    const rawDirectory = join(directory, "agent/perf/raw");
    const records = readdirSync(rawDirectory).filter(file => file.endsWith(".jsonl"))
      .flatMap(file => readFileSync(join(rawDirectory, file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    if (!records.some(row => row.kind === "startup" && Number.isFinite(row.values.readyMs) &&
      row.pid > 0 && row.mode === "rpc" && row.packages.includes("pi-perf-host-probe") && row.piVersion === installedPiVersion() && /^[a-f0-9]{16}$/.test(row.packagesHash))) throw new Error("missing cold-start record");
    console.log("OK perf.cold-start-storage");
    console.log("METRIC package-resolution-ms (RPC)", records.find(row => row.kind === "startup").packageResolveMs);
    if (result.error || result.status !== 0 || (output.match(/^OK /gm) ?? []).length !== 5 || /MISSING|Extension.*error/.test(output)) {
      process.stderr.write(result.error?.message ?? "perf host probe failed\n"); process.exitCode = 1;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
