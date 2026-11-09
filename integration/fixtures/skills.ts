import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";

export const RULE = "SKILLS_INTEGRATION_RULE: Never publish without the user's approval.";
export const CONTENTS = `---\nname: deploy\ndescription: Deploy safely\n---\n${RULE}\n`;

/** Only the provider and filesystem are fixtures; callers load production extensions. */
export function skillsFixture() {
  const root = mkdtempSync(join(tmpdir(), "skills-integration-"));
  const agentDir = join(root, "agent"), skillPath = join(root, "deploy", "SKILL.md");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(skillPath, CONTENTS);
  mkdirSync(join(agentDir, "pi-session-compact"), { recursive: true });
  writeFileSync(join(agentDir, "pi-session-compact", "config.json"), JSON.stringify({
    mode: "small", outputTokens: 1024, retry: { network: 0, invalidOutput: 0 },
    smallModel: { provider: "skills-faux", id: "small", effort: "off" },
  }));
  const requests: Array<{ model: string; messages: Message[] }> = [];
  const errors: string[] = [];
  const provider: ExtensionFactory = pi => {
    const faux = fauxProvider({ provider: "skills-faux", api: "skills-faux", tokensPerSecond: 10000000,
      models: [{ id: "main", contextWindow: 200000, maxTokens: 1024 }, { id: "small", contextWindow: 200000, maxTokens: 4096 }] });
    faux.setResponses(Array.from({ length: 40 }, () => (context, _options, _state, model) => {
      requests.push({ model: model.id, messages: structuredClone(context.messages) });
      // Deliberately omit the rules: only the real owner may embed them after generation.
      return fauxAssistantMessage(model.id === "small" ? "HANDOFF Continue the pending work." : "LOCAL_FAUX_OK");
    }));
    pi.registerProvider(faux.provider);
  };
  const start = (extensions: ExtensionFactory[], sm = SessionManager.create(root, join(root, "sessions"))) =>
    createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd: root, agentDir,
        settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false },
          compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 64 }, cacheWarming: "off" }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, additionalSkillPaths: [skillPath],
          noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
          systemPrompt: "Offline skill integration test", extensionFactories: [...extensions, provider] },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: services.modelRuntime.getModel("skills-faux", "main"), tools: [], thinkingLevel: "off" });
      await result.session.bindExtensions({ mode: "print", onError: event => errors.push(String(event.error)) });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd: root, agentDir, sessionManager: sm });
  return { root, agentDir, skillPath, requests, errors, start,
    cleanup() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function text(message: Message): string {
  return typeof message.content === "string" ? message.content
    : message.content.map(part => part.type === "text" ? part.text : JSON.stringify(part)).join("");
}
