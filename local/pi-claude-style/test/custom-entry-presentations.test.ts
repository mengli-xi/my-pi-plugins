import assert from "node:assert/strict";
import test from "node:test";
import { click } from "./native-mouse.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createCustomEntryDelegate } from "../../pi-processes/src/integrations/custom-entry-delegate.ts";
import {
  CtxStatusPresentationComponent,
  installCtxStatusPresentationProvider,
  installCustomEntryPresentationProviders,
  LoadedSkillPresentationComponent,
  ProcessEventPresentationComponent,
  SubagentCompletionPresentationComponent,
} from "../src/custom-entry-presentations.ts";
import {
  AGENT_SKILL_READ_ENTRY_TYPE,
  CTX_STATUS_CUSTOM_ENTRY_TYPE,
  CUSTOM_ENTRY_PRESENTATIONS_KEY,
  CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION,
  PROCESS_EVENT_CUSTOM_ENTRY_TYPE,
  SKILL_BINDING_ENTRY_TYPE,
  SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE,
} from "../src/integration-contracts.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function globals(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

function request(expanded = false, theme: Theme = plainTheme) {
  return {
    version: 1 as const,
    customType: CTX_STATUS_CUSTOM_ENTRY_TYPE as typeof CTX_STATUS_CUSTOM_ENTRY_TYPE,
    data: { level: "warning" },
    presentation: {
      title: "/ctx-embed",
      heading: "Historian warning",
      body: "The historian timed out.\nRetry later.",
      summary: "The historian timed out.",
    },
    options: { expanded },
    theme,
  };
}

test.afterEach(() => {
  delete globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY];
});

test("legacy ctx-status keeps the versioned presentation registry key", () => {
  assert.equal(
    CUSTOM_ENTRY_PRESENTATIONS_KEY_DESCRIPTION,
    "pi.claude-style.custom-entry-presentations.v1",
  );
});

test("the provider renders compact and expanded ctx-status rows", () => {
  let opened: { heading: string; body: string } | undefined;
  const registration = installCtxStatusPresentationProvider((heading, body) => {
    opened = { heading, body };
    return true;
  });
  try {
    const shared = globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY] as {
      providers: Map<string, { render(input: unknown): unknown }>;
    };
    const provider = shared.providers.get(CTX_STATUS_CUSTOM_ENTRY_TYPE);
    assert.ok(provider);

    const compact = provider.render(request()) as CtxStatusPresentationComponent;
    assert.deepEqual(compact.render(80), [
      "! /ctx-embed · The historian timed out.",
    ]);
    assert.equal(click(compact, 0, 0), true);
    assert.deepEqual(opened, {
      heading: "Historian warning",
      body: "The historian timed out.\nRetry later.",
    });

    const expanded = provider.render(request(true)) as CtxStatusPresentationComponent;
    assert.deepEqual(expanded.render(80).map((line) => line.trimEnd()), [
      "! /ctx-embed · The historian timed out.",
      "  The historian timed out.",
      "  Retry later.",
    ]);
    assert.equal(provider.render({ version: 2 }), undefined);
  } finally {
    registration.dispose();
  }
});

test("the process provider renders identity-first lifecycle output with equally dim semantic status colors", () => {
  let opened: { heading: string; body: string } | undefined;
  const calls: Array<[string, string]> = [];
  const theme = {
    fg: (color: string, text: string) => {
      calls.push([color, text]);
      return text;
    },
  } as unknown as Theme;
  const registration = installCustomEntryPresentationProviders((heading, body) => {
    opened = { heading, body };
    return true;
  });
  try {
    const shared = globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY] as {
      providers: Map<string, { render(input: unknown): unknown }>;
    };
    const provider = shared.providers.get(PROCESS_EVENT_CUSTOM_ENTRY_TYPE);
    assert.ok(provider);
    const component = provider.render({
      version: 1,
      customType: PROCESS_EVENT_CUSTOM_ENTRY_TYPE,
      data: {
        version: 2,
        kind: "terminal",
        text: "Process 'build' succeeded after 10s.",
        process: { name: "build" },
        terminal: { outcome: "succeeded", cause: "completed", durationMs: 10_000 },
        stdout: ["42 tests passed", "614 tests passed"],
        stderr: ["one warning"],
        details: { status: "succeeded" },
      },
      options: { expanded: true },
      theme,
    }) as ProcessEventPresentationComponent;
    assert.deepEqual(component.render(100).map((line) => line.replaceAll("\x1b[2m", "").replaceAll("\x1b[22m", "").trimEnd()), [
      "  Process 'build' succeeded after 10s",
      "  stdout: 42 tests passed",
      "  614 tests passed",
      "  stderr: one warning",
      '  {"status":"succeeded"}',
    ]);
    assert.ok(calls.some(([color, text]) => color === "muted" && text === "  Process 'build' "));
    assert.ok(calls.some(([color, text]) => color === "success" && text === "succeeded after 10s"));
    assert.equal(click(component, 0, 0), true);
    assert.deepEqual(opened, {
      heading: "Process 'build'",
      body: 'stdout:\n42 tests passed\n614 tests passed\nstderr:\none warning\n{\n  "status": "succeeded"\n}',
    });

    const renderTerminal = (terminal: Record<string, unknown>) => {
      calls.length = 0;
      const terminalComponent = provider.render({
        version: 1,
        customType: PROCESS_EVENT_CUSTOM_ENTRY_TYPE,
        data: { version: 2, kind: "terminal", text: "fallback", process: { name: "build" }, terminal },
        options: { expanded: false },
        theme,
      }) as ProcessEventPresentationComponent;
      return terminalComponent.render(100)[0]!.replaceAll("\x1b[2m", "").replaceAll("\x1b[22m", "").trimEnd();
    };
    assert.equal(renderTerminal({ outcome: "failed", cause: "exit-code", durationMs: 16_000, exitCode: 7 }), "  Process 'build' failed after 16s · exit code 7");
    assert.ok(calls.some(([color, text]) => color === "error" && text === "failed after 16s · exit code 7"));
    assert.equal(renderTerminal({ outcome: "failed", cause: "timeout", durationMs: 16_000, timeoutMs: 15_000 }), "  Process 'build' timed out after 16s · limit 15s");
    assert.ok(calls.some(([color, text]) => color === "warning" && text === "timed out after 16s · limit 15s"));
  } finally {
    registration.dispose();
  }
});

test("Subagent completion is one clickable line whose panel holds summary and result", () => {
  let opened: { heading: string; body: string; options?: unknown } | undefined;
  const registration = installCustomEntryPresentationProviders((heading, body, options) => {
    opened = { heading, body, options };
    return true;
  });
  try {
    const shared = globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY] as {
      providers: Map<string, { render(input: unknown): unknown }>;
    };
    const provider = shared.providers.get(SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE);
    assert.ok(provider);
    const component = provider.render({
      version: 1,
      customType: SUBAGENT_COMPLETION_CUSTOM_ENTRY_TYPE,
      completion: {
        taskPath: "/root/review",
        outcome: "completed",
        reason: "normal-final",
        summary: "Reviewed the implementation",
        result: "All checks passed.",
        resultTruncated: true,
        originalResultBytes: 4000,
        renderedResultBytes: 2000,
        totalTokens: 1234,
        durationMs: 5000,
      },
      options: { expanded: true, outputPad: 1 },
      theme: plainTheme,
    }) as SubagentCompletionPresentationComponent;
    assert.deepEqual(component.render(120), [
      " ✓ Agent '/root/review' completed · normal-final · 1.2k tokens · 5s",
    ]);
    assert.equal(click(component, 0, 0), true);
    assert.deepEqual(opened, {
      heading: "Agent completed: /root/review",
      body: "## Summary\n\nReviewed the implementation\n\n## Result\n\nAll checks passed.\n\n_Result truncated: 2,000 of 4,000 bytes._",
      options: { format: "markdown", glyph: "✓", tone: "text" },
    });
    assert.equal(provider.render({ version: 2 }), undefined);
  } finally {
    registration.dispose();
  }
});

test("loaded skills use accent rows and open the clicked skill as Markdown", () => {
  const opened: Array<{ heading: string; body: string; options?: unknown }> = [];
  const calls: Array<[string, string]> = [];
  const theme = {
    fg: (color: string, text: string) => {
      calls.push([color, text]);
      return text;
    },
  } as unknown as Theme;
  const registration = installCustomEntryPresentationProviders((heading, body, options) => {
    opened.push({ heading, body, options });
    return true;
  });
  try {
    const shared = globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY] as {
      providers: Map<string, { render(input: unknown): unknown }>;
    };
    for (const customType of [SKILL_BINDING_ENTRY_TYPE, AGENT_SKILL_READ_ENTRY_TYPE]) {
      const provider = shared.providers.get(customType);
      assert.ok(provider);
      const component = provider.render({
        version: 1,
        customType,
        skills: [
          { name: "deploy", path: "/skills/deploy/SKILL.md", contents: "# Deploy\n\nShip." },
          { name: "review", path: "/skills/review/SKILL.md", contents: "# Review\n\nCheck." },
        ],
        options: { expanded: true },
        theme,
      }) as LoadedSkillPresentationComponent;
      assert.deepEqual(component.render(80), [
        " ✦ Loaded skill deploy",
        " ✦ Loaded skill review",
      ]);
      assert.equal(click(component, 1, 0), true);
      assert.deepEqual(opened.at(-1), {
        heading: "Skill: review",
        body: "# Review\n\nCheck.",
        options: { format: "markdown", glyph: "✦", tone: "text" },
      });
    }
    assert.ok(calls.some(([color, text]) =>
      color === "accent" && text === " ✦ Loaded skill deploy"
    ));
  } finally {
    registration.dispose();
  }
});

test("the command label is brighter and distinct from dim separators", () => {
  const calls: Array<[string, string]> = [];
  const theme = {
    fg: (color: string, text: string) => {
      calls.push([color, text]);
      return text;
    },
  } as unknown as Theme;
  const component = new CtxStatusPresentationComponent(request(false, theme), () => false);
  component.render(80);
  assert.ok(calls.some(([color, text]) =>
    color === "customMessageLabel" && text === "/ctx-embed"
  ));
  assert.ok(calls.some(([color, text]) => color === "dim" && text === " · "));
  assert.ok(calls.some(([color, text]) =>
    color === "customMessageText" && text === "The historian timed out."
  ));
});

test("generic consumer components adopt and release the legacy ctx-status provider", () => {
  const fallback = { render: () => ["fallback"], invalidate() {} };
  const delegate = createCustomEntryDelegate(
    CTX_STATUS_CUSTOM_ENTRY_TYPE,
    request(false),
    fallback,
  );
  assert.deepEqual(delegate.render(80), ["fallback"]);

  const registration = installCtxStatusPresentationProvider(() => false);
  assert.equal(delegate.render(80)[0], "! /ctx-embed · The historian timed out.");
  registration.dispose();
  assert.deepEqual(delegate.render(80), ["fallback"]);
});

test("runtime replacement leases cannot remove the newer provider", () => {
  const first = installCtxStatusPresentationProvider(() => false);
  const shared = globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY] as {
    providers: Map<string, unknown>;
  };
  const firstProvider = shared.providers.get(CTX_STATUS_CUSTOM_ENTRY_TYPE);
  const second = installCtxStatusPresentationProvider(() => true);
  const secondProvider = shared.providers.get(CTX_STATUS_CUSTOM_ENTRY_TYPE);
  assert.notEqual(secondProvider, firstProvider);

  first.dispose();
  assert.equal(shared.providers.get(CTX_STATUS_CUSTOM_ENTRY_TYPE), secondProvider);
  second.dispose();
  assert.equal(shared.providers.has(CTX_STATUS_CUSTOM_ENTRY_TYPE), false);
});

test("an incompatible registry declines instead of breaking transcript startup", () => {
  const incompatible = { version: 2, providers: new Map() };
  globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY] = incompatible;
  const disposable = installCtxStatusPresentationProvider(() => false);
  disposable.dispose();
  assert.equal(globals()[CUSTOM_ENTRY_PRESENTATIONS_KEY], incompatible);
});
