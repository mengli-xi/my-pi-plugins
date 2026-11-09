import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionHandler,
  SessionEntry,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import skillMentions from "../index.ts";
import {
  SKILL_BINDING_ENTRY_TYPE,
  SKILL_INJECTION_MESSAGE_TYPE,
  type InvocationSnapshot,
} from "../invocations.ts";
import {
  AGENT_SKILL_READ_ENTRY_TYPE,
  type AgentSkillReadSnapshot,
} from "../loaded-skill-entry.ts";

type AnyHandler = ExtensionHandler<ExtensionEvent, unknown>;

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

test("autocomplete refresh discovers a skill added after session start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-skills-hot-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
    const startupPath = join(process.env.PI_CODING_AGENT_DIR, "skills", "startup", "SKILL.md");
    await mkdir(dirname(startupPath), { recursive: true });
    await writeFile(startupPath, "---\nname: cold-startup\ndescription: Original startup skill\n---\n");
    const commands: SlashCommandInfo[] = [{
      name: "skill:cold-startup", description: "Original startup skill", source: "skill",
      sourceInfo: { path: startupPath, source: "local", scope: "user", origin: "top-level" },
    }];
    const handlers = new Map<string, AnyHandler>();
    let providerFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
    const api = {
      on(event: string, handler: AnyHandler) {
        handlers.set(event, handler);
      },
      getCommands: () => commands,
      registerEntryRenderer() {},
      events: { on: () => () => {} },
    } as unknown as ExtensionAPI;
    skillMentions(api);
    const context = {
      mode: "tui",
      cwd: directory,
      isProjectTrusted: () => false,
      sessionManager: { getEntries: () => [] },
      ui: {
        addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
          providerFactory = factory;
        },
        notify() {},
      },
    } as unknown as ExtensionContext;
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, context);
    assert.ok(providerFactory);

    const provider = providerFactory({
      getSuggestions: async () => null,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
    assert.equal(await provider.getSuggestions(["Use $hot"], 0, 8, {} as never), null);

    const skillPath = join(process.env.PI_CODING_AGENT_DIR, "skills", "hot-skill", "SKILL.md");
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "---\nname: hot-skill\ndescription: Hot added skill\n---\n", "utf8");
    const suggestions = await provider.getSuggestions(["Use $hot"], 0, 8, {} as never);
    assert.ok(suggestions);
    assert.deepEqual(suggestions.items.map((item) => item.label), ["hot-skill"]);

    await writeFile(startupPath, "---\nname: fresh-startup\ndescription: Updated startup skill\n---\n");
    const query = "Use $fresh";
    const refreshed = await provider.getSuggestions([query], 0, query.length, {} as never);
    assert.ok(refreshed);
    assert.deepEqual(refreshed.items.map(item => item.label), ["fresh-startup"]);
    assert.match(refreshed.items[0]!.description ?? "", /Updated startup skill/);
    assert.equal(await provider.getSuggestions(["Use $cold"], 0, 9, {} as never), null);
    await rm(startupPath);
    assert.equal(await provider.getSuggestions([query], 0, query.length, {} as never), null,
      "a deleted startup command must not hide the refreshed catalog");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("extension keeps explicit and agent-read skills visible without changing model context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-skills-"));
  try {
    const skillPath = join(directory, "SKILL.md");
    const skillContents = "---\nname: deploy\ndescription: Deploy safely\n---\nDo the deployment.\n";
    await writeFile(skillPath, skillContents);
    const commands: SlashCommandInfo[] = [{
      name: "skill:deploy",
      description: "Deploy safely",
      source: "skill",
      sourceInfo: {
        path: skillPath,
        source: "local",
        scope: "project",
        origin: "top-level",
      },
    }];
    const handlers = new Map<string, AnyHandler>();
    const entryRenderers = new Map<string, EntryRenderer<unknown>>();
    const appended: Array<{ customType: string; data: unknown }> = [];
    const api = {
      on(event: string, handler: AnyHandler) {
        handlers.set(event, handler);
      },
      getCommands: () => commands,
      registerEntryRenderer(customType: string, renderer: EntryRenderer<unknown>) {
        entryRenderers.set(customType, renderer);
      },
      appendEntry(customType: string, data: unknown) {
        appended.push({ customType, data });
      },
      events: {
        on: () => () => {},
      },
    } as unknown as ExtensionAPI;
    skillMentions(api);

    const entries: SessionEntry[] = [];
    const notifications: string[] = [];
    const context = {
      mode: "rpc",
      sessionManager: { getEntries: () => entries },
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    const invoke = async <T>(name: string, event: ExtensionEvent): Promise<T> => {
      const handler = handlers.get(name);
      assert.ok(handler, `missing ${name} handler`);
      return await handler(event, context) as T;
    };

    await invoke("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(
      await invoke("input", { type: "input", text: "Use $deploy", source: "interactive" }),
      { action: "continue" },
    );
    const message = user("Use $deploy", 10);
    await invoke("message_end", { type: "message_end", message });
    entries.push({
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-11T00:00:00.000Z",
      message,
    });

    const result = await invoke<{ messages: AgentMessage[] }>("context", {
      type: "context",
      messages: [message],
    });
    assert.equal(result.messages[0], message, "the visible user message remains unchanged");
    assert.equal(result.messages[1]?.role, "custom");
    assert.equal(result.messages[1]?.customType, SKILL_INJECTION_MESSAGE_TYPE);
    assert.match(String(result.messages[1]?.content), /<name>deploy<\/name>/);
    assert.match(String(result.messages[1]?.content), /<path>.*SKILL\.md<\/path>/);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.customType, SKILL_BINDING_ENTRY_TYPE);
    assert.equal((appended[0]?.data as InvocationSnapshot).skills[0]?.path, skillPath);
    assert.deepEqual(notifications, []);

    const renderer = entryRenderers.get(SKILL_BINDING_ENTRY_TYPE);
    assert.ok(renderer);
    const entry = {
      type: "custom" as const,
      id: "binding-1",
      parentId: "user-1",
      timestamp: "2026-08-11T00:00:00.001Z",
      customType: SKILL_BINDING_ENTRY_TYPE,
      data: appended[0]?.data,
    };
    const theme = { fg: (_color: string, text: string) => text } as never;
    const hints = { keyHint: () => "", keyText: () => "" };
    const collapsed = renderer(entry, { expanded: false, ...hints }, theme);
    const expanded = renderer(entry, { expanded: true, ...hints }, theme);
    assert.ok(collapsed);
    assert.ok(expanded);
    assert.deepEqual(collapsed.render(80), expanded.render(80));
    assert.match(collapsed.render(80).join("\n"), /Loaded skill deploy/);

    const rewound = await invoke<{ messages: AgentMessage[] }>("context", {
      type: "context",
      messages: [user("Earlier", 1)],
    });
    assert.equal(
      rewound.messages.some((candidate) => (
        candidate.role === "custom" && candidate.customType === SKILL_INJECTION_MESSAGE_TYPE
      )),
      false,
      "rewinding before the source user removes the request-only injection",
    );

    const commandResult = await invoke<{ action: string; text?: string }>("input", {
      type: "input",
      text: "/skill:deploy production west",
      source: "interactive",
    });
    assert.deepEqual(commandResult, {
      action: "transform",
      text: "$deploy production west",
    });

    const commandMessage = user("$deploy production west", 20);
    await invoke("message_end", { type: "message_end", message: commandMessage });
    entries.push({
      type: "message",
      id: "user-2",
      parentId: "user-1",
      timestamp: "2026-08-11T00:00:01.000Z",
      message: commandMessage,
    });

    const commandContext = await invoke<{ messages: AgentMessage[] }>("context", {
      type: "context",
      messages: [commandMessage],
    });
    assert.equal(commandContext.messages[0], commandMessage);
    assert.equal(commandContext.messages[1]?.role, "custom");
    assert.equal(commandContext.messages[1]?.customType, SKILL_INJECTION_MESSAGE_TYPE);
    assert.match(String(commandContext.messages[1]?.content), /<name>deploy<\/name>/);
    assert.equal(appended.length, 2);
    assert.equal(appended[1]?.customType, SKILL_BINDING_ENTRY_TYPE);
    assert.equal((appended[1]?.data as InvocationSnapshot).text, "$deploy production west");
    assert.equal((appended[1]?.data as InvocationSnapshot).skills[0]?.path, skillPath);

    await invoke("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt: "Deploy",
      systemPrompt: "",
      systemPromptOptions: {
        cwd: directory,
        selectedTools: ["read"],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {},
        contextFiles: [],
        skills: [{
          name: "deploy",
          description: "Deploy safely",
          filePath: skillPath,
          baseDir: directory,
          sourceInfo: {
            path: skillPath,
            source: "local",
            scope: "project",
            origin: "top-level",
          },
          disableModelInvocation: false,
        }],
      },
    });
    const readResult = {
      content: [{ type: "text" as const, text: skillContents }],
      details: undefined,
    };
    await invoke("tool_result", {
      type: "tool_result",
      toolCallId: "read-skill",
      toolName: "read",
      input: { path: skillPath },
      content: readResult.content,
      details: readResult.details,
      isError: false,
    });
    await invoke("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "read-skill",
      toolName: "read",
      result: readResult,
      isError: false,
    });
    await invoke("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: user("done", 30),
      messageEntryId: "message-1",
      toolResultEntryIds: ["result-1"],
      entries: [],
      continue: false,
      context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
      outcome: "completed",
      toolResults: [{
        role: "toolResult",
        toolCallId: "read-skill",
        toolName: "read",
        content: readResult.content,
        isError: false,
        timestamp: 31,
      }],
    });
    assert.equal(appended[2]?.customType, AGENT_SKILL_READ_ENTRY_TYPE);
    assert.deepEqual((appended[2]?.data as AgentSkillReadSnapshot).skill, {
      name: "deploy",
      path: skillPath,
      contents: skillContents,
    });

    await invoke("tool_result", {
      type: "tool_result", toolCallId: "nested-read", toolName: "read", parentToolCallId: "code-1",
      input: { path: skillPath }, content: readResult.content, details: undefined, isError: false,
    });
    await invoke("tool_execution_end", {
      type: "tool_execution_end", toolCallId: "nested-read", toolName: "read", parentToolCallId: "code-1",
      result: readResult, isError: false,
    });
    assert.equal(appended.length, 3, "nested read does not append before its parent is persisted");
    await invoke("turn_end", {
      type: "turn_end", turnIndex: 2, message: user("done", 32),
      messageEntryId: "message-2", toolResultEntryIds: ["result-code-1"],
      entries: [], continue: false,
      context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
      outcome: "completed",
      toolResults: [{
        role: "toolResult", toolCallId: "code-1", toolName: "codemode",
        content: [], isError: false, timestamp: 33,
        nestedCalls: { complete: true, calls: [{ id: "nested-read", name: "read", status: "ok" }] },
      }],
    });
    assert.equal(appended.length, 4);
    assert.equal(appended[3]?.customType, AGENT_SKILL_READ_ENTRY_TYPE);
    assert.equal((appended[3]?.data as AgentSkillReadSnapshot).toolCallId, "nested-read");

    assert.deepEqual(
      await invoke("input", {
        type: "input",
        text: "/skill:missing args",
        source: "interactive",
      }),
      { action: "continue" },
      "unknown native commands fall through to Pi",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
