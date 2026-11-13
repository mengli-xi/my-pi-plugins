import { piBin, installedPiVersion } from "../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.argv.length, 2, "check:host does not accept profile arguments");
const binary = piBin();
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cc-memory-host-")));
const home = join(root, "home");
const agent = join(root, "agent");
const cwd = join(root, "cwd");
const sessionDir = join(root, "sessions");
const session = join(sessionDir, "session.jsonl");
const requests = join(root, "requests.jsonl");
const fixtureRoot = join(root, "faux-provider");
const fixture = join(fixtureRoot, "index.ts");
const artifactDir = process.env.PI_MEMORY_HOST_ARTIFACTS;
const children = [];
const diagnostics = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const entries = () => readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const systemEntries = () => entries().filter((entry) => entry.type === "message" && entry.message.role === "system");
const hostVersion = execFileSync(binary, ["--version"], {
  cwd: root, encoding: "utf8",
  env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_NEXT_AGENT_DIR: agent, XDG_CONFIG_HOME: join(root, "config") },
}).trim();
assert.equal(hostVersion, installedPiVersion(), "host verification requires the installed SDK version");
const evidence = { binary, hostVersion, realRequests: 0, checks: [] };
const check = (label, value) => { assert.ok(value, label); evidence.checks.push(label); };

async function until(predicate, label, child, stderr, timeout = 45000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = predicate();
    if (result) return result;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`${label}: process exited ${child.exitCode}\n${stderr()}`);
    if (Date.now() >= deadline) throw new Error(`${label}: timeout\n${stderr()}`);
    await delay(20);
  }
}

function start() {
  const child = spawn(binary, ["--offline", "--mode", "rpc", "--session-dir", sessionDir, "--session", session, "--provider", "memory-faux", "--model", "memory-faux", "--thinking", "off", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes"], {
    cwd,
    env: { ...process.env, HOME: home, PI_NEXT_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", XDG_CONFIG_HOME: join(root, "config") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const records = [];
  let buffer = "", stderr = "", sequence = 0;
  let failure;
  child.on("error", (error) => { failure = error; });
  child.stdin.on("error", (error) => { failure = error; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line) {
        try { records.push(JSON.parse(line)); } catch { stderr += `${line}\n`; }
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; diagnostics.push(chunk.toString()); });
  const wait = (predicate, label) => until(() => { if (failure) throw failure; return predicate(); }, label, child, () => stderr);
  const rpc = async (type, params = {}) => {
    const id = `memory-${++sequence}`;
    child.stdin.write(`${JSON.stringify({ type, id, ...params })}\n`);
    const response = await wait(() => records.find((record) => record.type === "response" && record.id === id), type);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };
  const prompt = async (message) => {
    const offset = records.length;
    await rpc("prompt", { message });
    await wait(() => records.slice(offset).some((record) => record.type === "agent_end"), message);
    assert.equal(records.slice(offset).some((record) => record.type === "extension_error"), false, JSON.stringify(records.slice(offset)));
    assert.equal(records.slice(offset).some((record) => record.type === "message_end" && record.message?.stopReason === "error"), false);
  };
  return { child, rpc, prompt, records, stderr: () => stderr };
}

async function stop(runtime) {
  if (runtime.child.exitCode !== null) return;
  runtime.child.stdin.end();
  try { await until(() => runtime.child.exitCode !== null, "stdin shutdown", undefined, runtime.stderr, 10000); }
  catch { runtime.child.kill("SIGTERM"); await until(() => runtime.child.exitCode !== null, "SIGTERM shutdown", undefined, runtime.stderr, 10000); }
  assert.equal(runtime.child.exitCode, 0, runtime.stderr());
}

try {
  for (const directory of [home, agent, cwd, sessionDir]) mkdirSync(directory);
  execFileSync("git", ["init", cwd], { stdio: "pipe" });
  const commonDir = realpathSync(join(cwd, ".git"));
  const settingsPath = join(agent, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    packages: [packageRoot, fixtureRoot], extensions: ["-builtin:mcp"],
    retry: { enabled: false }, cacheWarming: "off",
    compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 100 },
  }));
  const fauxUrl = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
  mkdirSync(fixtureRoot);
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ name: "memory-host-faux", type: "module", pi: { extensions: ["./index.ts"] } }));
  writeFileSync(fixture, `import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(fauxUrl)};
export default function(pi) {
  const faux = fauxProvider({ provider: "memory-faux", api: "memory-faux", models: [{ id: "memory-faux", contextWindow: 200000, maxTokens: 8192 }], tokensPerSecond: 10000000 });
  faux.setResponses(Array.from({length: 50}, () => (context) => {
    appendFileSync(${JSON.stringify(requests)}, JSON.stringify(context) + "\\n");
    return fauxAssistantMessage("MEMORY_FAUX_OK " + "summary ".repeat(800));
  }));
  pi.registerProvider(faux.provider);
  pi.on("before_agent_start", event => { event.systemPromptOptions.sections.memory_fixture_other_owner = "preserve other owner"; });
}`);
  const memoryDir = join(agent, "pi-cc-memory/projects", createHash("sha256").update(`git:${commonDir}`).digest("hex"), "memory");
  // Seed before process startup: session_start freezes the index even before the first prompt.
  mkdirSync(memoryDir, { recursive: true });
  const indexPath = join(memoryDir, "MEMORY.md");
  writeFileSync(indexPath, "- [Version one](v1.md) — MEMORY_DISK_V1\n");
  writeFileSync(join(memoryDir, "large.md"), Buffer.alloc(12289));
  let runtime = start();
  const commands = await runtime.rpc("get_commands");
  check("RPC get_commands completed", commands !== undefined);
  check("session_start accepts existing memory directory", existsSync(memoryDir));
  const capturedRequests = () => readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const mainSystem = (marker) => {
    const selected = capturedRequests().filter((request) => {
      const lastUser = request.messages.findLast((message) => message.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      return text.trimEnd().endsWith(marker);
    });
    assert.equal(selected.length, 1, `exactly one actual main provider request for ${marker}`);
    return getSystemMessageText(getCurrentSystemMessage(selected[0].messages));
  };
  await runtime.prompt("MEMORY_HOST_FIRST");
  let systems = systemEntries();
  check("policy and disk index persisted as sections", systems.some((entry) => entry.message.sections?.cc_memory_policy && entry.message.sections?.cc_memory_index?.includes("MEMORY_DISK_V1")));
  const policy = systems.find((entry) => entry.message.sections?.cc_memory_policy).message.sections.cc_memory_policy;
  check("English policy requires a tool-checked modified date on creation and every edit, without injecting today's date", policy.includes("On creation and every edit, use a tool to check the current date and set metadata.modified") && !/[\u3400-\u9fff]|\d{4}-\d{2}-\d{2}/u.test(policy));
  check("other owner's section preserved", systems.some((entry) => entry.message.sections?.memory_fixture_other_owner?.includes("preserve other owner")));
  {
    check("English index explanation and topic warning injected", systems.some((entry) => entry.message.sections?.cc_memory_index?.includes("Complete index:") && entry.message.sections.cc_memory_index.includes("Oversized topics (full bodies remain readable):")));
    const memorySections = () => systemEntries().filter((entry) => ["cc_memory_policy", "cc_memory_index"].some((key) => key in (entry.message.sections ?? {})));
    const priorCount = memorySections().length;
    const initialSystem = mainSystem("MEMORY_HOST_FIRST");
    await runtime.prompt("MEMORY_HOST_UNCHANGED");
    check("unchanged content creates no new memory section patch", memorySections().length === priorCount);
    writeFileSync(indexPath, "- [Version two](v2.md) — MEMORY_DISK_V2\n");
    writeFileSync(join(memoryDir, "large.md"), Buffer.alloc(13000));
    writeFileSync(join(memoryDir, "new-large.md"), Buffer.alloc(14000));
    const stableSystems = [mainSystem("MEMORY_HOST_UNCHANGED")];
    for (let i = 1; i <= 3; i++) {
      const marker = `MEMORY_HOST_CHANGED_${i}`;
      await runtime.prompt(marker);
      stableSystems.push(mainSystem(marker));
    }
    check("mid-session index and topic size changes create no memory system patch", memorySections().length === priorCount);
    check("actual system content stays byte-identical for four subsequent requests", stableSystems.every((system) => Buffer.from(system).equals(Buffer.from(initialSystem))));
    evidence.frozenSystem = { requests: stableSystems.length + 1, utf8Bytes: Buffer.byteLength(initialSystem), sha256: createHash("sha256").update(initialSystem).digest("hex") };

    await runtime.rpc("compact");
    const compaction = entries().findLast((entry) => entry.type === "compaction");
    check("manual compaction checkpoint keeps the previous snapshot", compaction?.systemMessage?.sections?.cc_memory_index?.includes("MEMORY_DISK_V1"));
    check("compaction itself does not create a memory system patch", memorySections().length === priorCount);
    await runtime.prompt("MEMORY_HOST_COMPACTED");
    const compactedSystem = mainSystem("MEMORY_HOST_COMPACTED");
    check("next request after manual compact uses V2 and no stale V1", compactedSystem.includes("MEMORY_DISK_V2") && !compactedSystem.includes("MEMORY_DISK_V1"));
    check("compaction refresh also updates model-facing topic size notes", compactedSystem.includes("large.md: 13000") && compactedSystem.includes("new-large.md: 14000"));
    check("only index changes in the post-compaction memory patch", memorySections().at(-1).message.sections.cc_memory_index.includes("MEMORY_DISK_V2") && !("cc_memory_policy" in memorySections().at(-1).message.sections));

    await stop(runtime);
    writeFileSync(indexPath, "- [Version three](v3.md) — MEMORY_DISK_V3\n");
    runtime = start();
    await runtime.rpc("get_state");
    await runtime.prompt("MEMORY_HOST_RESUMED");
    const resumedSystem = mainSystem("MEMORY_HOST_RESUMED");
    check("resume uses current disk V3 without stale V1 or V2", resumedSystem.includes("MEMORY_DISK_V3") && !resumedSystem.includes("MEMORY_DISK_V1") && !resumedSystem.includes("MEMORY_DISK_V2"));
    check("historical index retained", systemEntries().some((entry) => entry.message.sections?.cc_memory_index?.includes("MEMORY_DISK_V1")));
  }
  await stop(runtime);
  const captured = readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  check("faux provider actually received memory section", captured.some((request) => JSON.stringify(request.messages).includes("MEMORY_DISK_V1")));
  evidence.providerSystemShapes = captured.map((request) => request.messages.filter((message) => message.role === "system").map((message) => ({ sectionKeys: Object.keys(message.sections ?? {}), hasIndexInContent: JSON.stringify(message.content).includes("MEMORY_DISK_V1") })));
  evidence.fauxRequests = captured.length;
  evidence.systemRecords = systemEntries().length;
  evidence.extensionErrors = runtime.records.filter((record) => record.type === "extension_error");
  check("no extension errors", evidence.extensionErrors.length === 0);
} finally {
  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    for (const [name, path] of [["requests.jsonl", requests], ["session.jsonl", session]]) {
      if (existsSync(path)) writeFileSync(join(artifactDir, name), readFileSync(path));
    }
    writeFileSync(join(artifactDir, "checks.json"), JSON.stringify(evidence, null, 2));
    writeFileSync(join(artifactDir, "stderr.log"), diagnostics.join(""));
  }
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    try { await until(() => child.exitCode !== null || child.signalCode !== null, "host cleanup", undefined, () => "", 10000); }
    catch (error) {
      child.kill("SIGKILL");
      await until(() => child.exitCode !== null || child.signalCode !== null, "forced host cleanup", undefined, () => String(error), 10000);
    }
  }
  check("no temporary Pi processes remain", children.every((child) => child.exitCode !== null || child.signalCode !== null));
  rmSync(root, { recursive: true, force: true });
  check("temporary directory removed", !existsSync(root));
  if (artifactDir) writeFileSync(join(artifactDir, "checks.json"), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence, null, 2));
