import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "dist", "index.ts");
const binary = resolve(process.argv[2] ?? process.env.PI_BINARY ?? "");

if (!process.argv[2] && !process.env.PI_BINARY) {
  console.error("usage: npm run check-provider-errors:host -- /path/to/final/pi");
  process.exit(2);
}
if (!existsSync(binary)) {
  console.error(`final Pi binary not found: ${binary}`);
  process.exit(2);
}
const binaryVersion = execFileSync(binary, ["--version"], {
  encoding: "utf8",
  timeout: 5_000,
}).trim();
if (binaryVersion !== "1.5.0") {
  console.error(`expected final Pi 1.5.0 binary, got ${JSON.stringify(binaryVersion)}`);
  process.exit(2);
}
if (!existsSync(extensionPath)) {
  console.error(`production build not found: ${extensionPath}; run npm run build first`);
  process.exit(2);
}

let root;
let home;
let agentDir;
let sessionDir;
let tempDir;
let providerPath;
let tuiLaunchPath;
let tuiSocketPath;
let tuiServer;
let tuiServerClosed;
let tuiServerStderr = () => "";
let tuiPanePid;
let tuiSessionMayExist = false;
const fauxUrl = JSON.stringify(
  import.meta.resolve("@earendil-works/pi-ai/providers/faux"),
);
const expectedErrorMessages = [1, 2, 3].map((attempt) =>
  `Provider upstream returned error code 4027 (attempts=2, stage=event_assemble/upstream_error, backend_http=503, upstream_code=4027, request_id=req_HOST_${attempt}, provider_log_id=log_HOST_${attempt}, retryable=true)`
);
const RPC_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
  "response",
  "extension_ui_request",
  "extension_error",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireField(record, name, predicate, line) {
  if (!predicate(record[name])) {
    throw new Error(`RPC ${record.type} has invalid ${name}: ${line}`);
  }
}

const STOP_REASONS = new Set([
  "pending", "stop", "length", "toolUse", "error", "aborted", "deferred",
]);

function validUsage(value) {
  if (!isObject(value) || !isObject(value.cost)) return false;
  return [
    value.input,
    value.output,
    value.cacheRead,
    value.cacheWrite,
    value.totalTokens,
    value.cost.input,
    value.cost.output,
    value.cost.cacheRead,
    value.cost.cacheWrite,
    value.cost.total,
  ].every(Number.isFinite);
}

function validMessage(value) {
  if (!isObject(value) || !["system", "user", "assistant", "toolResult"].includes(value.role)) {
    return false;
  }
  if (!Number.isFinite(value.timestamp)) return false;
  if (value.role === "system") {
    return typeof value.content === "string" && (value.sections === undefined || (isObject(value.sections) &&
        Object.values(value.sections).every(section => section === null || typeof section === "string"))) &&
      (value.toolsAdded === undefined || Array.isArray(value.toolsAdded)) &&
      (value.toolsRemoved === undefined || (Array.isArray(value.toolsRemoved) && value.toolsRemoved.every(name => typeof name === "string")));
  }
  if (value.role === "user") {
    return typeof value.content === "string" || Array.isArray(value.content);
  }
  if (value.role === "toolResult") {
    return typeof value.toolCallId === "string" &&
      typeof value.toolName === "string" &&
      Array.isArray(value.content) &&
      typeof value.isError === "boolean";
  }
  return Array.isArray(value.content) &&
    typeof value.api === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    validUsage(value.usage) &&
    STOP_REASONS.has(value.stopReason) &&
    (value.stopReason !== "error" || typeof value.errorMessage === "string");
}

function parseRpcRecord(line) {
  const record = JSON.parse(line);
  if (!isObject(record)) {
    throw new Error(`RPC stdout record is not an object: ${line}`);
  }
  if (typeof record.type !== "string" || !RPC_EVENT_TYPES.has(record.type)) {
    throw new Error(`RPC stdout record has an unknown type: ${line}`);
  }
  switch (record.type) {
    case "response":
      requireField(record, "id", (value) => typeof value === "string" && value.length > 0, line);
      requireField(record, "command", (value) => typeof value === "string", line);
      requireField(record, "success", (value) => typeof value === "boolean", line);
      if (record.success === false) {
        requireField(record, "error", (value) => typeof value === "string", line);
      }
      break;
    case "message_start":
    case "message_end":
      requireField(record, "message", validMessage, line);
      break;
    case "message_update":
      requireField(record, "usage", isObject, line);
      requireField(record, "assistantMessageEvent", (value) => isObject(value) && typeof value.type === "string", line);
      break;
    case "agent_end":
      requireField(record, "messages", Array.isArray, line);
      requireField(record, "willRetry", (value) => typeof value === "boolean", line);
      break;
    case "turn_end":
      requireField(record, "message", isObject, line);
      requireField(record, "toolResults", Array.isArray, line);
      break;
    case "tool_execution_start":
    case "tool_execution_update":
      requireField(record, "toolCallId", (value) => typeof value === "string", line);
      requireField(record, "toolName", (value) => typeof value === "string", line);
      break;
    case "tool_execution_end":
      requireField(record, "toolCallId", (value) => typeof value === "string", line);
      requireField(record, "toolName", (value) => typeof value === "string", line);
      requireField(record, "isError", (value) => typeof value === "boolean", line);
      break;
    case "queue_update":
      requireField(record, "steering", Array.isArray, line);
      requireField(record, "followUp", Array.isArray, line);
      break;
    case "compaction_start":
      requireField(record, "reason", (value) => typeof value === "string", line);
      break;
    case "compaction_end":
      requireField(record, "reason", (value) => typeof value === "string", line);
      requireField(record, "aborted", (value) => typeof value === "boolean", line);
      requireField(record, "willRetry", (value) => typeof value === "boolean", line);
      break;
    case "entry_appended":
      requireField(record, "entry", isObject, line);
      break;
    case "session_info_changed":
      if (record.name !== undefined && typeof record.name !== "string") {
        throw new Error(`RPC session_info_changed has invalid name: ${line}`);
      }
      break;
    case "thinking_level_changed":
      requireField(record, "level", (value) => typeof value === "string", line);
      break;
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      requireField(record, "attempt", Number.isInteger, line);
      requireField(record, "maxAttempts", Number.isInteger, line);
      requireField(record, "delayMs", Number.isFinite, line);
      requireField(record, "errorMessage", (value) => typeof value === "string", line);
      break;
    case "auto_retry_end":
      requireField(record, "success", (value) => typeof value === "boolean", line);
      requireField(record, "attempt", Number.isInteger, line);
      if (record.finalError !== undefined && typeof record.finalError !== "string") {
        throw new Error(`RPC auto_retry_end has invalid finalError: ${line}`);
      }
      break;
    case "summarization_retry_attempt_start":
      requireField(record, "source", (value) => value === "branchSummary" || value === "compaction", line);
      break;
    case "bash_execution_update":
      requireField(record, "delta", (value) => typeof value === "string", line);
      break;
    case "extension_ui_request":
      requireField(record, "id", (value) => typeof value === "string", line);
      requireField(record, "method", (value) => typeof value === "string", line);
      break;
    case "extension_error":
      requireField(record, "extensionPath", (value) => typeof value === "string", line);
      requireField(record, "event", (value) => typeof value === "string", line);
      requireField(record, "error", (value) => typeof value === "string", line);
      break;
  }
  return record;
}

function providerSource(errors, provider) {
  return `
import { fauxAssistantMessage, fauxProvider } from ${fauxUrl};

const failures = ${JSON.stringify(errors)}.map((errorMessage, index) =>
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage,
    timestamp: (index + 1) * 1000,
  })
);

export default function install(pi) {
  const faux = fauxProvider({
    provider: ${JSON.stringify(provider)},
    api: "repeated-error-faux",
    models: [{
      id: "repeated-error-faux",
      name: "Repeated Error Faux",
      reasoning: false,
      contextWindow: 32768,
      maxTokens: 1024,
    }],
  });
  faux.setResponses(failures);
  pi.registerProvider(faux.provider);
}
`;
}

function startRpc(
  extraExtensions,
  sessionArgs = ["--session-dir", sessionDir],
  modelArgs = [],
) {
  const child = spawn(binary, [
    "--mode", "rpc",
    "--offline",
    ...sessionArgs,
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    ...modelArgs,
    ...extraExtensions.flatMap((path) => ["--extension", path]),
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      TMPDIR: tempDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  let processError;
  let protocolError;
  let exit;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) {
        protocolError = new Error("blank RPC stdout record");
        continue;
      }
      try {
        events.push(parseRpcRecord(line));
      } catch (error) {
        protocolError = error;
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { processError = error; });
  child.stdin.on("error", (error) => { processError = error; });
  child.stdout.on("error", (error) => { processError = error; });
  child.stderr.on("error", (error) => { processError = error; });
  const closed = new Promise((resolveExit) => {
    child.once("close", (code, signal) => {
      exit = { code, signal };
      resolveExit(exit);
    });
  });

  const waitFor = async (predicate, label, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (processError) throw processError;
      if (protocolError) throw protocolError;
      if (exit) throw new Error(`${label}: Pi exited early ${JSON.stringify(exit)}\n${stderr}`);
      if (Date.now() >= deadline) throw new Error(`${label}: timed out\n${stderr}`);
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const command = async (input) => {
    const id = input.id ?? `request-${++sequence}`;
    const start = events.length;
    child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
    const response = await waitFor(
      () => events.slice(start).find((event) =>
        event.type === "response" &&
        event.id === id &&
        event.command === input.type
      ),
      `${input.type} response`,
    );
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  };
  const close = async () => {
    child.stdin.end();
    let exitTimer;
    try {
      const result = await Promise.race([
        closed,
        new Promise((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error(`Pi did not exit\n${stderr}`)),
            30_000,
          );
        }),
      ]);
      if (processError) throw processError;
      if (protocolError) throw protocolError;
      assert.equal(buffer, "", `incomplete RPC stdout: ${JSON.stringify(buffer)}`);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.equal(stderr, "", stderr);
      assert.deepEqual(
        events.filter((event) => event.type === "extension_error"),
        [],
        JSON.stringify(events.filter((event) => event.type === "extension_error")),
      );
    } finally {
      clearTimeout(exitTimer);
    }
  };
  return { child, closed, command, events, waitFor, close };
}

async function terminateChild(child, closed) {
  if (!child || !closed) return;
  if (child.exitCode === null && child.signalCode === null) {
    const signalled = child.kill("SIGKILL");
    if (!signalled && child.exitCode === null && child.signalCode === null) {
      throw new Error(`failed to kill child pid ${child.pid ?? "unknown"}`);
    }
  }
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`child pid ${child.pid ?? "unknown"} did not exit after SIGKILL`)),
          3_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function runTmux(args, options = {}) {
  const child = spawn("tmux", ["-S", tuiSocketPath, ...args], {
    cwd: packageRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  let timer;
  try {
    const exit = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`tmux ${args[0] ?? "command"} timed out`));
        }, options.timeoutMs ?? 10_000);
      }),
    ]);
    if (!options.allowFailure && (exit.code !== 0 || exit.signal !== null)) {
      throw new Error(
        `tmux ${args.join(" ")} failed: ${JSON.stringify(exit)}\n${stderr}${stdout}`,
      );
    }
    return { ...exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function isUsablePid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

function pidAlive(pid) {
  if (!isUsablePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
  }
  return !pidAlive(pid);
}

async function startTmuxServer() {
  const child = spawn("tmux", ["-f", "/dev/null", "-D", "-S", tuiSocketPath], {
    cwd: packageRoot,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let processError;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { processError = error; });
  child.stdout.resume();
  const closed = new Promise((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  // Publish ownership before any awaited startup check. If socket creation or
  // later initialization fails, the outer finally still owns this exact child.
  tuiServer = child;
  tuiServerClosed = closed;
  tuiServerStderr = () => stderr;
  const deadline = Date.now() + 5_000;
  while (!existsSync(tuiSocketPath)) {
    if (processError) throw processError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`tmux server exited before creating its socket\n${stderr}`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error(`tmux server did not create its socket\n${stderr}`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  return { child, closed, stderr: () => stderr };
}

async function cleanupTui() {
  if (!tuiServer || !tuiServerClosed) {
    if (tuiSocketPath && existsSync(tuiSocketPath)) await rm(tuiSocketPath, { force: true });
    return;
  }
  if (!isUsablePid(tuiPanePid) && existsSync(tuiSocketPath)) {
    const panes = await runTmux(
      ["list-panes", "-a", "-F", "#{pane_pid}"],
      { allowFailure: true, timeoutMs: 1_000 },
    ).catch(() => undefined);
    const panePids = panes?.stdout
      .trim()
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter(isUsablePid);
    if (panePids?.length === 1) tuiPanePid = panePids[0];
  }
  const missingPaneProof = tuiSessionMayExist && !isUsablePid(tuiPanePid);
  await runTmux(["kill-server"], { allowFailure: true, timeoutMs: 3_000 })
    .catch(() => undefined);
  if (tuiServer.exitCode === null && tuiServer.signalCode === null) {
    tuiServer.kill("SIGTERM");
  }
  let exit = await Promise.race([
    tuiServerClosed,
    new Promise((resolve) => setTimeout(() => resolve(undefined), 1_000)),
  ]);
  if (!exit && tuiServer.exitCode === null && tuiServer.signalCode === null) {
    tuiServer.kill("SIGKILL");
    exit = await Promise.race([
      tuiServerClosed,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 2_000)),
    ]);
  }
  const errors = [];
  if (!exit) errors.push(new Error(`owned tmux server did not exit\n${tuiServerStderr()}`));
  if (missingPaneProof) {
    errors.push(new Error("tmux cleanup could not prove which pane process the fixture created"));
  } else if (!await waitForPidGone(tuiPanePid, 2_000)) {
    errors.push(new Error(`tmux cleanup left pane pid ${tuiPanePid}`));
  }
  if (existsSync(tuiSocketPath)) await rm(tuiSocketPath, { force: true });
  if (existsSync(tuiSocketPath)) {
    errors.push(new Error(`tmux cleanup left socket: ${tuiSocketPath}`));
  }
  if (errors.length > 0) throw new AggregateError(errors, "tmux cleanup did not converge");
}

async function waitForTui(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let pane = "";
  for (;;) {
    const captured = await runTmux(
      ["capture-pane", "-p", "-J", "-t", "provider-errors"],
      { allowFailure: true },
    );
    if (captured.code === 0) {
      pane = captured.stdout;
      if (predicate(pane)) return pane;
    } else {
      const alive = await runTmux(["has-session", "-t", "provider-errors"], {
        allowFailure: true,
      });
      if (alive.code !== 0) {
        throw new Error(`${label}: TUI exited before the expected frame\n${pane}\n${captured.stderr}`);
      }
    }
    if (Date.now() >= deadline) {
      const state = await runTmux([
        "list-panes", "-t", "provider-errors", "-F",
        "#{pane_dead} #{pane_dead_status} #{alternate_on} #{pane_current_command}",
      ], { allowFailure: true });
      throw new Error(`${label}: timed out\n${pane}\n${state.stdout}${state.stderr}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

let active;
let resumed;
let runError;
try {
  root = await mkdtemp(join(tmpdir(), "pi-claude-style-provider-errors-"));
  home = join(root, "home");
  agentDir = join(root, "agent");
  sessionDir = join(root, "sessions");
  tempDir = join(root, "tmp");
  providerPath = join(root, "provider.mjs");
  tuiLaunchPath = join(root, "launch-tui.sh");
  tuiSocketPath = join(root, "tmux.sock");
  for (const path of [home, agentDir, sessionDir, tempDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
  }, null, 2), { mode: 0o600 });
  await writeFile(providerPath, providerSource(expectedErrorMessages, "provider-errors-faux"), { mode: 0o600 });

  active = startRpc(
    [providerPath, extensionPath],
    ["--session-dir", sessionDir],
    ["--provider", "provider-errors-faux", "--model", "repeated-error-faux", "--api-key", "offline"],
  );
  const promptStart = active.events.length;
  const prompt = await active.command({ type: "prompt", message: "trigger deterministic retry" });
  assert.equal(prompt.success, true, JSON.stringify(prompt));
  await active.waitFor(
    () => active.events.slice(promptStart).find((event) => event.type === "agent_settled"),
    "agent_settled",
  );
  const messageStarts = active.events.slice(promptStart)
    .filter((event) =>
      event.type === "message_start" &&
      event.message?.role === "assistant" &&
      event.message?.provider === "provider-errors-faux"
    )
    .map((event) => event.message);
  const errors = active.events.slice(promptStart)
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant" && event.message?.stopReason === "error")
    .map((event) => event.message);
  const retryStarts = active.events.slice(promptStart).filter((event) => event.type === "auto_retry_start");
  const retryEnd = active.events.slice(promptStart).find((event) => event.type === "auto_retry_end");
  const settled = active.events.slice(promptStart).filter((event) => event.type === "agent_settled");
  assert.equal(messageStarts.length, 3, JSON.stringify(active.events.slice(promptStart)));
  assert.equal(errors.length, 3, JSON.stringify(active.events.slice(promptStart)));
  assert.deepEqual(
    messageStarts.map((message) => ({
      api: message.api,
      provider: message.provider,
      model: message.model,
      errorMessage: message.errorMessage,
    })),
    errors.map((message) => ({
      api: message.api,
      provider: message.provider,
      model: message.model,
      errorMessage: message.errorMessage,
    })),
    "each retry's assistant message_start preserves the final error envelope identity",
  );
  assert.deepEqual(
    errors.map((message) => message.errorMessage),
    expectedErrorMessages,
    "RPC events preserve the faux provider's exact error envelopes",
  );
  assert.deepEqual(retryStarts.map((event) => event.attempt), [1, 2]);
  assert.equal(retryEnd?.success, false, JSON.stringify(retryEnd));
  assert.equal(retryEnd?.attempt, 2, JSON.stringify(retryEnd));
  assert.equal(retryEnd?.finalError, errors[2]?.errorMessage);
  assert.equal(settled.length, 1);
  assert.equal(
    active.events.some((event) => event.type === "extension_error"),
    false,
    JSON.stringify(active.events.filter((event) => event.type === "extension_error")),
  );
  const stateResponse = await active.command({ type: "get_state" });
  assert.equal(stateResponse.success, true, JSON.stringify(stateResponse));
  const sessionFile = stateResponse.data.sessionFile;
  assert.equal(typeof sessionFile, "string", JSON.stringify(stateResponse));
  assert.equal(sessionFile.startsWith(sessionDir), true, sessionFile);
  await active.close();
  active = undefined;
  assert.equal(existsSync(sessionFile), true, `session file missing: ${sessionFile}`);

  resumed = startRpc([], ["--session", sessionFile]);
  const resumedEntries = await resumed.command({ type: "get_entries" });
  assert.equal(resumedEntries.success, true, JSON.stringify(resumedEntries));
  const persistedErrors = resumedEntries.data.entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message?.stopReason === "error")
    .map((entry) => entry.message);
  for (const message of persistedErrors) {
    assert.equal(
      validMessage(message),
      true,
      `restored session contains a malformed assistant error: ${JSON.stringify(message)}`,
    );
  }
  assert.deepEqual(
    persistedErrors.map((message) => message.errorMessage),
    expectedErrorMessages,
    "a fresh final-binary process restores the exact provider error envelopes from session JSONL",
  );
  await resumed.close();
  resumed = undefined;

  for (const scenario of [
    {
      provider: "provider-errors-faux",
      errors: expectedErrorMessages,
      summary: "Provider upstream returned error code 4027",
    },
    {
      provider: "gateway-faux",
      errors: Array(5).fill("Error: Provider service temporarily unavailable: upstream_error: upstream error upstream_code=3004 (upstream_code=3004, retryable=true)"),
      summary: "Provider service temporarily unavailable: upstream_error: upstream error upstream_code=3004",
    },
  ]) {
    await writeFile(providerPath, providerSource(scenario.errors, scenario.provider), { mode: 0o600 });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      retry: { enabled: true, maxRetries: scenario.errors.length - 1, baseDelayMs: 0 },
    }), { mode: 0o600 });
    const tuiSessionDir = join(root, `tui-sessions-${scenario.provider}`);
    await mkdir(tuiSessionDir, { recursive: true, mode: 0o700 });
    const tuiCommand = [
      shellQuote(binary),
      "--offline",
      "--session-dir", shellQuote(tuiSessionDir),
      "--approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "--tui-mode", "fullscreen",
      "--provider", shellQuote(scenario.provider),
      "--model", "repeated-error-faux",
      "--api-key", "offline",
      "--extension", shellQuote(providerPath),
      "--extension", shellQuote(extensionPath),
      shellQuote("trigger deterministic retry"),
    ].join(" ");
    await writeFile(tuiLaunchPath, [
      "#!/bin/sh",
      `export HOME=${shellQuote(home)}`,
      `export PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
      `export PI_CODING_AGENT_SESSION_DIR=${shellQuote(tuiSessionDir)}`,
      `export TMPDIR=${shellQuote(tempDir)}`,
      "export PI_OFFLINE=1",
      "export TERM=xterm-256color",
      `exec ${tuiCommand}`,
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(tuiLaunchPath, 0o700);
    await startTmuxServer();
    tuiSessionMayExist = true;
    const tuiIdentity = await runTmux([
      "new-session", "-d", "-P", "-F", "#{pid} #{pane_pid}",
      "-x", "160", "-y", "48", "-s", "provider-errors", tuiLaunchPath,
    ]);
    const [serverPidText, panePidText] = tuiIdentity.stdout.trim().split(/\s+/u);
    const serverPid = Number.parseInt(serverPidText, 10);
    tuiPanePid = Number.parseInt(panePidText, 10);
    if (serverPid !== tuiServer.pid || !isUsablePid(tuiPanePid)) {
      throw new Error(`tmux new-session returned invalid process identity: ${tuiIdentity.stdout}`);
    }
    const pane = await waitForTui(
      (screen) => screen.includes(`${scenario.summary} ${scenario.errors.length}/${scenario.errors.length}`),
      `collapsed ${scenario.provider} retry row`,
    );
    const finalRow = `${scenario.summary} ${scenario.errors.length}/${scenario.errors.length}`;
    assert.equal(pane.split(finalRow).length - 1, 1, pane);
    assert.equal(pane.includes("×"), false, pane);
    for (const requestId of ["req_HOST_1", "req_HOST_2", "req_HOST_3"]) {
      assert.equal(pane.includes(requestId), false, pane);
    }
    assert.equal(pane.includes("Retry failed after"), false, pane);
    assert.equal(scenario.errors.some((message) => pane.includes(message)), false, pane);
    console.log(`pi 1.5.0 real TUI · ${scenario.provider} · ${scenario.errors.length} errors · one ${finalRow} row`);
    await cleanupTui();
    tuiServer = undefined;
    tuiServerClosed = undefined;
    tuiPanePid = undefined;
    tuiSessionMayExist = false;
  }
} catch (error) {
  runError = error;
} finally {
  const cleanup = await Promise.allSettled([
    terminateChild(active?.child, active?.closed),
    terminateChild(resumed?.child, resumed?.closed),
    cleanupTui(),
  ]);
  let removeError;
  try {
    if (root) await rm(root, { recursive: true, force: true });
  } catch (error) {
    removeError = error;
  }
  const cleanupErrors = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (removeError) cleanupErrors.push(removeError);
  if (runError && cleanupErrors.length) {
    throw new AggregateError(
      [runError, ...cleanupErrors],
      "Provider error host fixture and cleanup both failed",
    );
  }
  if (runError) throw runError;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, "failed to clean provider error host fixture");
  }
}
