/**
 * Service installer: writes a launchd (macOS) or systemd user (Linux) unit
 * that keeps the daemon alive across logout/reboot (decision #12), then loads
 * it. Generating the unit text is pure and unit-tested; the load/unload calls
 * shell out to the platform service manager.
 *
 * The unit runs `<runtime> <daemonEntry>` with the resolved agent dir and pi
 * binary baked into the environment, so the boot-launched daemon uses the same
 * paths a Pi session would.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Each Pi profile owns its service, just as it owns its daemon socket/store. */
export function serviceLabel(agentDir: string): string {
  const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 12);
  return `works.earendil.pi-scheduler-${digest}`;
}

export function systemdUnitName(agentDir: string): string {
  return `${serviceLabel(agentDir)}.service`;
}

export interface ServiceSpec {
  /** Node/Bun runtime that runs the daemon entry (process.execPath). */
  runtime: string;
  /** Absolute path to the compiled/loadable daemon entry. */
  daemonEntry: string;
  /** Agent dir the daemon uses. */
  agentDir: string;
  /** pi binary tasks are executed with. */
  piBinary: string;
  /** Daemon log path. */
  logPath: string;
  concurrency?: number;
}

/** macOS launchd plist. RunAtLoad + KeepAlive = boot-start + crash-restart. */
export function launchdPlist(spec: ServiceSpec): string {
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: spec.agentDir,
    PI_SCHEDULER_BINARY: spec.piBinary,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || tmpdir(),
  };
  if (spec.concurrency) env.PI_SCHEDULER_CONCURRENCY = String(spec.concurrency);
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${k}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel(spec.agentDir)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(spec.runtime)}</string>
    <string>${escapeXml(spec.daemonEntry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(spec.logPath)}</string>
</dict>
</plist>
`;
}

/** systemd user service unit. WantedBy=default.target = start on login/boot. */
export function systemdUnit(spec: ServiceSpec): string {
  const env = [
    `Environment=${unitWord(`PI_CODING_AGENT_DIR=${spec.agentDir}`)}`,
    `Environment=${unitWord(`PI_SCHEDULER_BINARY=${spec.piBinary}`)}`,
  ];
  env.push(`Environment=${unitWord(`XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || tmpdir()}`)}`);
  if (spec.concurrency) env.push(`Environment=PI_SCHEDULER_CONCURRENCY=${spec.concurrency}`);
  return `[Unit]
Description=Pi scheduler daemon
After=default.target

[Service]
Type=simple
ExecStart=:${unitWord(spec.runtime)} ${unitWord(spec.daemonEntry)}
${env.join("\n")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function launchdPlistPath(agentDir: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${serviceLabel(agentDir)}.plist`);
}

export function systemdUnitPath(agentDir: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user", systemdUnitName(agentDir));
}

export interface InstallResult {
  platform: "darwin" | "linux" | "unsupported";
  unitPath?: string;
  loaded: boolean;
  detail?: string;
}

/** Write and load the service for the current platform. */
export function installService(spec: ServiceSpec): InstallResult {
  const os = platform();
  if (os === "darwin") {
    const unitPath = launchdPlistPath(spec.agentDir);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, launchdPlist(spec));
    // bootout old instance (ignore failure), then bootstrap the new one.
    const uid = process.getuid?.() ?? 0;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${serviceLabel(spec.agentDir)}`], { stdio: "ignore" });
    const loaded = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, unitPath], { stdio: "ignore" });
    return {
      platform: "darwin",
      unitPath,
      loaded: loaded.status === 0,
      detail: loaded.status === 0 ? undefined : `launchctl bootstrap exit ${loaded.status}`,
    };
  }
  if (os === "linux") {
    const unitPath = systemdUnitPath(spec.agentDir);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, systemdUnit(spec));
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const enabled = spawnSync("systemctl", ["--user", "enable", "--now", systemdUnitName(spec.agentDir)], { stdio: "ignore" });
    return {
      platform: "linux",
      unitPath,
      loaded: enabled.status === 0,
      detail: enabled.status === 0 ? undefined : `systemctl enable exit ${enabled.status}`,
    };
  }
  return { platform: "unsupported", loaded: false, detail: `unsupported platform: ${os}` };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** systemd.syntax quoting; %% prevents specifier expansion, : disables ExecStart $ expansion. */
function unitWord(value: string): string {
  return '"' + value.replace(/[%\\"\n\r\t]/g, character => ({
    "%": "%%", "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t",
  })[character]!) + '"';
}
