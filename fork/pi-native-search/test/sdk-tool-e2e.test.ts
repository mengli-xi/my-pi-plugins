import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSessionServices, createAgentSessionFromServices, SessionManager,
  SettingsManager, initTheme, VERSION,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { installSearch, SEARCH_BACKENDS_REQUEST_V1, type SearchBackendEvents, type SearchConfig } from "../extensions/index.ts";
import { createSearchChildFactory } from "../extensions/child.ts";

for (const provider of ["fixture-public", "fixture-optional", "fixture-optional-success"]) {
  for (const child of [false, true]) {
    test(`Pi 1.5 SDK ${child ? "named child factory" : "Main"} ${provider} search fallback, fetch and schema validation`, async () => {
      assert.equal(VERSION, "1.5.0");
      initTheme("dark");
      const root = mkdtempSync(join(tmpdir(), "pi-search-e2e-"));
      const cwd = join(root, "cwd"), agentDir = join(root, "agent");
      mkdirSync(cwd); mkdirSync(agentDir);
      const requests: string[] = [];
      const url = "https://page.fixture.invalid/fixture";
      const originalFetch = globalThis.fetch;
      let ddgCalls = 0;
      globalThis.fetch = async (input, init) => {
        const target = String(input);
        if (target.startsWith("https://html.duckduckgo.com/html/?q=")) {
          ddgCalls++;
          return new Response('<a class="result__a" href="https://fixture.invalid/result">Offline result</a><a class="result__snippet">Offline snippet</a>');
        }
        assert.equal(target, url, "all requests must use in-memory fixtures");
        requests.push(target);
        return new Response("<h1>Offline fixture</h1><script>never shown</script><p>Offline page</p>",
          { headers: { "Content-Type": "text/html" } });
      };
      const faux = fauxProvider({ provider, api: `offline-${provider}`, models: [{ id: "fixture" }], tokensPerSecond: 100000 });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("web_search", { query: "offline query" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("web_fetch", { url }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("web_search", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Offline complete"),
      ]);
      const config: SearchConfig = { enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} };
      const errors: unknown[] = [];
      let backendEvents: SearchBackendEvents | undefined;
      let backendCalls = 0;
      let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
      let services: Awaited<ReturnType<typeof createAgentSessionServices>> | undefined;
      try {
        services = await createAgentSessionServices({ cwd, agentDir,
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
          resourceLoaderOptions: {
            noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
            extensionFactories: [pi => {
              pi.registerProvider(faux.provider);
              backendEvents = pi.events;
              if (provider !== "fixture-public") pi.events.on(SEARCH_BACKENDS_REQUEST_V1, (payload: any) => {
                payload.contribute({ version: 1, id: "fixture-backend", label: "Offline backend", defaultProviders: [provider],
                  async search({ ctx }: any) {
                    assert.equal(ctx.model.provider, provider);
                    backendCalls++;
                    if (provider === "fixture-optional-success") return "Offline optional result";
                    throw new Error("offline optional backend unavailable");
                  },
                });
              });
            }, child
              ? pi => createSearchChildFactory(config, { backendEvents })(pi)
              : pi => installSearch(pi, { child: false, config, agentDir })],
          },
        });
        ({ session } = await createAgentSessionFromServices({ services, cwd, agentDir,
          sessionManager: SessionManager.inMemory(cwd), model: services.modelRuntime.getModel(provider, "fixture"),
          tools: ["web_search", "web_fetch"],
        }));
        await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
        await session.prompt("Run only the offline fixture operations.");
        const results = session.messages.filter(message => message.role === "toolResult");
        assert.equal(results.length, 3);
        assert.deepEqual(results.map(result => result.isError), [false, false, true]);
        assert.equal((results[0].details as { method: string }).method, provider === "fixture-optional-success" ? "native" : "ddg");
        const searchText = results[0].content[0]; assert.equal(searchText.type, "text");
        if (provider === "fixture-optional") assert.match(searchText.text, /Native failed \(offline optional backend unavailable\)/);
        else assert.doesNotMatch(searchText.text, /Native failed/);
        assert.equal(backendCalls, provider === "fixture-public" ? 0 : 1);
        assert.match(searchText.text, provider === "fixture-optional-success" ? /Offline optional result/ : /Offline result/);
        const pageText = results[1].content[0]; assert.equal(pageText.type, "text");
        assert.equal(pageText.text, "Offline fixture Offline page");
        assert.equal((results[1].details as { method: string }).method, "local");
        const invalidText = results[2].content[0]; assert.equal(invalidText.type, "text");
        assert.match(invalidText.text, /query: missing/);
        assert.equal(ddgCalls, provider === "fixture-optional-success" ? 0 : 1, "invalid arguments must never reach execution or fallback");
        assert.deepEqual(requests, [url]);
        assert.equal(session.getLastAssistantText(), "Offline complete");
        assert.deepEqual(errors, []);
      } finally {
        session?.dispose();
        globalThis.fetch = originalFetch;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("bare SDK /search commands emit readable messages without UI or a model turn", async () => {
  initTheme("dark");
  const root = mkdtempSync(join(tmpdir(), "pi-search-no-ui-"));
  const cwd = join(root, "cwd"), agentDir = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  const faux = fauxProvider({ provider: "fixture-no-ui", api: "fixture-no-ui", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage("A command must not call the model")]);
  const errors: unknown[] = [], replies: string[] = [];
  let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  try {
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        extensionFactories: [pi => {
          pi.registerProvider(faux.provider);
          pi.on("session_start", (_event, ctx) => { assert.equal(ctx.hasUI, false); });
          installSearch(pi, { child: false, config: { enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} }, agentDir });
        }],
      },
    });
    ({ session } = await createAgentSessionFromServices({ services, cwd, agentDir,
      sessionManager: SessionManager.inMemory(cwd), model: services.modelRuntime.getModel("fixture-no-ui", "fixture"),
      tools: ["web_search", "web_fetch"],
    }));
    session.subscribe(event => {
      if (event.type !== "message_end" || event.message.role !== "custom") return;
      assert.equal(event.message.customType, "native-search-command");
      assert.equal(event.message.display, true);
      assert.equal(typeof event.message.content, "string");
      replies.push(event.message.content as string);
    });
    await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    assert.deepEqual(replies, [], "startup must not print configuration");
    for (const [args, expected] of [["config", /Extension: enabled/], ["providers", /openai: search: native-capable/], ["unknown", /Usage: \/search \[on\|off\|providers\|config\]/]] as const) {
      await session.prompt(`/search ${args}`);
      assert.match(replies.at(-1)!, expected);
      assert.equal(faux.state.callCount, 0, "read-only command replies must not trigger a model turn");
    }
    assert.equal(replies.length, 3);
    assert.equal(session.messages.filter(message => message.role === "custom").length, 3);
    assert.deepEqual(errors, []);
  } finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
