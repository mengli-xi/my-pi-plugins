import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, createBashToolDefinition, createReadToolDefinition, SessionManager, SettingsManager, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { createClaudeStyleChildExtension } from "../src/child-factory.ts";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_CATALOG } from "../src/config/catalog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		return statSync(path).isDirectory()
			? sourceFiles(path)
			: path.endsWith(".ts") ? [path] : [];
	});
}

test("Pi is the only third-party extension factory owner", () => {
	const source = sourceFiles(join(root, "src"))
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
	for (const retired of [
		"loadHostedIntegrations",
		"installIntegrationsFeature",
		"duplicateWithPi",
		"createJiti",
		"SessionNamingController",
		"registerBuiltinTools",
	]) {
		assert.equal(source.includes(retired), false, `retired control-plane symbol returned: ${retired}`);
	}

	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(manifest.dependencies?.jiti, undefined, "Jiti must remain Pi-owned/transitive");
	assert.equal(CONFIG_CATALOG.some(({ path }) => path === "integrations" || path === "features.integrations"), false);
	assert.equal(/\b(?:pi|api)\.registerTool\(/u.test(source), false, "CC owns renderers, never execution definitions");
});

test("presentation keeps the profile's seven native tools and a separate bash owner's required timeout", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cc-tool-ownership-"));
	const standard = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	try {
		for (const tools of [undefined, ["read"], []]) {
			const provider = fauxProvider({ provider: "cc-tool-fixture", api: "cc-tool-fixture", models: [{ id: "model", contextWindow: 32768, maxTokens: 256 }] });
			const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({ cwd: directory, agentDir: directory,
					settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], defaultTools: standard }),
					resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
						disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], extensionFactories: [
							pi => { pi.registerProvider(provider.provider); pi.registerTool({ ...createBashToolDefinition(directory), prepareArguments: undefined,
								parameters: Type.Object({ command: Type.String(), timeout: Type.Number({ exclusiveMinimum: 0 }) }),
							}); },
							pi => createClaudeStyleChildExtension({ target: "subagent", taskName: "ownership", returnLabel: "Main", readOnlyStatusline: true })(new Proxy(pi, {
								get(target, key) { if (key === "registerTool") return () => { throw new Error("CC attempted execution ownership"); }; return Reflect.get(target, key); },
							})),
						] } });
				assert.deepEqual(services.resourceLoader.getExtensions().errors, [], "a second owner must not be silently skipped");
				const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
					model: services.modelRuntime.getModel("cc-tool-fixture", "model"), ...(tools === undefined ? {} : { tools }) });
				await result.session.bindExtensions({ mode: "print" });
				return { ...result, services, diagnostics: services.diagnostics };
			}, { cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory) });
			try {
				assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...(tools ?? standard)].sort());
				const available = runtime.session.getAllTools();
				if (tools === undefined) {
					for (const name of standard) assert.ok(available.some(tool => tool.name === name), `${name} remains available`);
					const bash = available.find(tool => tool.name === "bash")!;
					assert.notEqual(bash.sourceInfo.source, "builtin", "the overriding domain owner remains authoritative");
					assert.ok((bash.parameters as { required?: string[] }).required?.includes("timeout"));
				}
				if (tools === undefined || tools.includes("read")) {
					assert.equal(runtime.session.extensionRunner?.resolveToolRenderers("read", () => createReadToolDefinition(directory) as unknown as ToolRenderers)?.renderShell, "self");
				}
				assert.equal(provider.state.callCount, 0);
			} finally { await runtime.dispose(); }
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});
