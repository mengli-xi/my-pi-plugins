import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { CONFIG_CATALOG, NUMBER_RANGES } from "../src/config/catalog.ts";
import { ConfigService } from "../src/config/service.ts";

async function temporary<T>(run: (agentDir: string) => Promise<T> | T): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "cc-style-config-"));
	try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("v6 reads and corrupt stores do not load Conf; the first mutation loads its atomic writer", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	for (const bytes of [
		JSON.stringify({ schemaVersion: 6, revision: 7, overrides: { performance: { enabled: true } } }),
		"{ not json\n",
		JSON.stringify({ schemaVersion: 6, revision: 7, overrides: { working: { refreshMs: "fast" } } }),
	]) {
		writeFileSync(path, bytes);
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { createRequire } from "node:module";
			import { readFileSync } from "node:fs";
			import { ConfigService } from ${JSON.stringify(new URL("../src/config/service.ts", import.meta.url).href)};
			const require = createRequire(${JSON.stringify(new URL("../package.json", import.meta.url).href)});
			const confPath = require.resolve("conf");
			assert.equal(require.cache[confPath], undefined);
			const service = new ConfigService({ agentDir: ${JSON.stringify(agentDir)}, env: {} });
			assert.equal(require.cache[confPath], undefined);
			assert.equal(readFileSync(service.path, "utf8"), ${JSON.stringify(bytes)});
			if (service.degradedError) {
				assert.throws(() => service.set("performance.enabled", false), /read-only/);
				assert.equal(require.cache[confPath], undefined);
				assert.equal(readFileSync(service.path, "utf8"), ${JSON.stringify(bytes)});
			} else {
				assert.equal(service.active.performance.enabled, true);
				service.set("performance.enabled", false);
				assert.ok(require.cache[confPath]);
				const saved = JSON.parse(readFileSync(service.path, "utf8"));
				assert.equal(saved.revision, 8);
				assert.equal(saved.overrides.performance.enabled, false);
			}
		`], { encoding: "utf8", timeout: 30_000 });
		assert.equal(child.error, undefined);
		assert.equal(child.status, 0, child.stderr || child.stdout);
	}
}));

test("the catalog has unique paths and every default validates", () => {
	assert.equal(new Set(CONFIG_CATALOG.map(({ path }) => path)).size, CONFIG_CATALOG.length);
	for (const descriptor of CONFIG_CATALOG) {
		assert.deepEqual(descriptor.validate(descriptor.defaultValue), descriptor.defaultValue, descriptor.path);
		assert.ok(["live", "reload", "restart"].includes(descriptor.apply));
		assert.ok(descriptor.owner);
	}
	const paths = CONFIG_CATALOG.map(({ path }) => path);
	assert.ok(!paths.includes("transcript.enabled"));
	assert.ok(!paths.some((path) => path.startsWith("transcript.working.")));
	assert.ok(!paths.includes("transcript.integrations"));
	assert.ok(!paths.includes("features.integrations"));
	assert.ok(!paths.includes("integrations"));
	assert.ok(!paths.some((path) => path.startsWith("transcript.sessionNaming")));
	assert.ok(!paths.includes("working.enabled"));
	for (const descriptor of CONFIG_CATALOG) {
		if (typeof descriptor.defaultValue === "number") {
			assert.ok(NUMBER_RANGES[descriptor.path], `missing numeric range for ${descriptor.path}`);
		}
	}
});

test("catalog rejects invalid enums and previously unclamped numeric values", async () => temporary((agentDir) => {
	const service = new ConfigService({ agentDir, env: {} });
	assert.throws(() => service.set("loading.mode", "sideways"), /expects one of/);
	assert.throws(() => service.set("transcript.goal.refreshMs", 0), /250\.\.10000/);
	assert.throws(() => service.set("transcript.userMessages.horizontalPadding", -1), /0\.\.4/);
}));

test("default, user, and env priority are reported separately", async () => temporary((agentDir) => {
	const service = new ConfigService({ agentDir, env: { PI_CC_STYLE_PERF: "1" } });
	assert.equal(service.get("features.transcript").source, "default");
	const mutation = service.set("features.transcript", false);
	assert.equal(mutation.pending, false);
	assert.equal(mutation.apply, "reload");
	assert.equal(service.get("features.transcript").stored, false);
	assert.deepEqual(service.get("performance.enabled"), {
		path: "performance.enabled",
		active: true,
		stored: undefined,
		pending: undefined,
		source: "env",
		apply: "live",
	});
}));

test("live performance values update active state while UI values stay pending", async () => temporary((agentDir) => {
	const service = new ConfigService({ agentDir, env: {} });
	service.set("performance.enabled", true);
	assert.equal(service.get("performance.enabled").active, true);
	assert.equal(service.get("performance.enabled").pending, undefined);
	service.set("working.refreshMs", 240);
	assert.equal(service.get("working.refreshMs").active, 120);
	assert.equal(service.get("working.refreshMs").pending, 240);
}));

test("environment values keep priority over live mutations and reset-all restores live defaults", async () => temporary((agentDir) => {
	const service = new ConfigService({ agentDir, env: { PI_CC_STYLE_PERF: "1" } });
	service.set("performance.enabled", false);
	assert.equal(service.get("performance.enabled").active, true);
	assert.equal(service.get("performance.enabled").source, "env");
	service.set("performance.logEnabled", true);
	assert.equal(service.get("performance.logEnabled").active, true);
	service.resetAll();
	assert.equal(service.get("performance.enabled").active, true);
	assert.equal(service.get("performance.logEnabled").active, false);
}));

test("the shared diff highlight migrates to both operation colours", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const original = JSON.stringify({
		schemaVersion: 5,
		revision: 3,
		overrides: { transcript: { diff: { highlightBg: 90 } } },
	});
	writeFileSync(path, original);
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.active.transcript.diff.addedHighlightBg, 90);
	assert.equal(service.active.transcript.diff.removedHighlightBg, 90);
	assert.deepEqual(service.diagnostics().unknownPaths, []);
	const stored = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(stored.overrides.transcript.diff, {
		addedHighlightBg: 90,
		removedHighlightBg: 90,
	});
	assert.equal(readFileSync(`${path}.schema-v5.bak`, "utf8"), original);
}));

test("schema v1 drops retired hosting paths and preserves unrelated overrides", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const original = JSON.stringify({
		schemaVersion: 1,
		revision: 7,
		overrides: {
			features: { transcript: false, integrations: true },
			integrations: [{ source: "npm:pi-native-search", enabled: true }],
		},
	});
	writeFileSync(path, original);
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.active.features.transcript, false);
	assert.equal("integrations" in service.active.features, false);
	assert.equal("integrations" in service.active, false);
	assert.deepEqual(service.diagnostics().unknownPaths, []);
	const stored = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(stored.schemaVersion, 6);
	assert.equal(stored.revision, 8);
	assert.deepEqual(stored.overrides, { features: { transcript: false } });
	assert.equal(readFileSync(`${path}.schema-v1.bak`, "utf8"), original);
}));

test("read-only child projects a legacy schema without writing config or a backup", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const original = JSON.stringify({
		schemaVersion: 3,
		revision: 11,
		overrides: {
			features: { transcript: false, layout: false },
			layout: { align: "top" },
		},
	});
	writeFileSync(path, original);
	const service = new ConfigService({ agentDir, env: {}, readOnly: true });
	assert.equal(service.active.features.transcript, false);
	assert.equal("layout" in service.active.features, false);
	assert.equal(readFileSync(path, "utf8"), original);
	assert.throws(() => readFileSync(`${path}.schema-v3.bak`, "utf8"), /ENOENT/);
	assert.throws(() => service.set("features.transcript", true), /read-only/);
}));

test("schema v2 retires session naming after leaving a migration backup", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const original = JSON.stringify({
		schemaVersion: 2,
		revision: 4,
		overrides: {
			transcript: {
				sessionNaming: { model: "fixture-provider/example", effort: "low", maxChars: 30 },
				maxGroups: 80,
			},
		},
	});
	writeFileSync(path, original);
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.active.transcript.maxGroups, 80);
	assert.equal("sessionNaming" in service.active.transcript, false);
	const stored = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(stored.schemaVersion, 6);
	assert.equal(stored.revision, 5);
	assert.deepEqual(stored.overrides, { transcript: { maxGroups: 80 } });
	assert.equal(readFileSync(`${path}.schema-v2.bak`, "utf8"), original);
}));

test("a corrupt store is byte-for-byte preserved and becomes read-only", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const bytes = "{ definitely-not-json\n";
	writeFileSync(path, bytes);
	const service = new ConfigService({ agentDir, env: {} });
	assert.match(service.degradedError ?? "", /JSON|position|property/i);
	assert.throws(() => service.set("features.transcript", false), /read-only/);
	assert.equal(readFileSync(path, "utf8"), bytes);
}));

test("forced recovery backs up corrupt bytes before writing fresh defaults", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const bytes = "{ broken forever\n";
	writeFileSync(path, bytes);
	const service = new ConfigService({ agentDir, env: {}, now: () => new Date("2026-08-08T01:02:03.004Z") });

	const backup = service.recoverResetAll();

	assert.equal(backup, `${path}.invalid-2026-08-08T01-02-03-004Z.bak`);
	assert.equal(readFileSync(backup!, "utf8"), bytes);
	assert.equal(service.degradedError, undefined);
	assert.equal(service.get("features.transcript").source, "default");
	service.set("performance.enabled", true);
	assert.equal(service.active.performance.enabled, true);
}));

test("a type-invalid store is also preserved and diagnosed as read-only", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const bytes = JSON.stringify({ schemaVersion: 1, revision: 2, overrides: { working: { refreshMs: "fast" } } });
	writeFileSync(path, bytes);
	const service = new ConfigService({ agentDir, env: {} });
	assert.match(service.degradedError ?? "", /working\.refreshMs/);
	assert.equal(readFileSync(path, "utf8"), bytes);
}));

test("an unavailable config directory degrades instead of crashing construction", async () => temporary((root) => {
	const agentDir = join(root, "agent-file");
	writeFileSync(agentDir, "not a directory");
	const service = new ConfigService({ agentDir, env: {} });
	assert.match(service.degradedError ?? "", /store unavailable|not a directory|ENOTDIR/i);
	assert.equal(service.active.features.transcript, true);
	assert.throws(() => service.set("features.transcript", false), /read-only/);
}));

test("optimistic concurrency rejects a same-revision external rewrite", async () => temporary((agentDir) => {
	const service = new ConfigService({ agentDir, env: {} });
	const parsed = JSON.parse(readFileSync(service.path, "utf8"));
	writeFileSync(service.path, `${JSON.stringify(parsed)}\n`);
	assert.throws(() => service.set("features.transcript", false), /another pi session/);
}));

test("legacy transcript and retired Pinned settings migrate once", async () => temporary((agentDir) => {
	const transcriptDir = join(agentDir, "extensions", "pi-claude-transcript");
	mkdirSync(transcriptDir, { recursive: true });
	const transcriptPath = join(transcriptDir, "config.json");
	const layoutPath = join(agentDir, "pi-pinned-layout.json");
	const transcript = JSON.stringify({ enabled: false, working: { refreshMs: 300 }, integrations: [] });
	const layout = JSON.stringify({ enabled: false, mouse: false });
	writeFileSync(transcriptPath, transcript);
	writeFileSync(layoutPath, layout);
	const first = new ConfigService({ agentDir, env: {}, now: () => new Date("2026-01-02T03:04:05Z") });
	assert.equal(first.active.features.transcript, false);
	assert.equal(first.active.working.refreshMs, 300);
	assert.equal(first.active.features.working, true);
	assert.equal(first.diagnostics().migration?.sources.length, 2);
	const second = new ConfigService({ agentDir, env: {} });
	assert.deepEqual(second.diagnostics().migration, first.diagnostics().migration);
	assert.equal(readFileSync(transcriptPath, "utf8"), transcript);
	assert.equal(readFileSync(layoutPath, "utf8"), layout);
}));

test("schema v3 retires layout ownership and leaves an exact migration backup", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const original = JSON.stringify({
		schemaVersion: 3,
		revision: 11,
		overrides: {
			features: { transcript: false, layout: false },
			layout: { align: "top", mouse: false },
			working: { enabled: false, refreshMs: 240 },
		},
	});
	writeFileSync(path, original);
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.active.features.transcript, false);
	assert.equal(service.active.features.working, false);
	assert.equal(service.active.working.refreshMs, 240);
	const stored = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(stored.schemaVersion, 6);
	assert.equal(stored.revision, 12);
	assert.deepEqual(stored.overrides, { features: { transcript: false, working: false }, working: { refreshMs: 240 } });
	assert.equal(readFileSync(`${path}.schema-v3.bak`, "utf8"), original);
}));

test("schema v4 adopts the layered loader and preserves explicit rollback intent", async () => temporary((agentDir) => {
	const directory = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "config.json");
	const original = JSON.stringify({
		schemaVersion: 4,
		revision: 14,
		overrides: { loading: { mode: "legacy" }, transcript: { maxGroups: 90 } },
	});
	writeFileSync(path, original);
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.active.loading.mode, "eager");
	assert.equal(service.active.loading.idleDelayMs, 250);
	const stored = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(stored.schemaVersion, 6);
	assert.equal(stored.revision, 15);
	assert.deepEqual(stored.overrides, { loading: { mode: "eager" }, transcript: { maxGroups: 90 } });
	assert.equal(readFileSync(`${path}.schema-v4.bak`, "utf8"), original);
}));

test("legacy working.enabled migrates to the canonical feature switch", async () => temporary((agentDir) => {
	const transcriptDir = join(agentDir, "extensions", "pi-claude-transcript");
	mkdirSync(transcriptDir, { recursive: true });
	writeFileSync(join(transcriptDir, "config.json"), JSON.stringify({ working: { enabled: false, refreshMs: 300 } }));
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.active.features.working, false);
	assert.equal(service.active.working.refreshMs, 300);
	assert.equal(service.diagnostics().unknownPaths.includes("working.enabled"), false);
}));

test("invalid legacy values are skipped instead of poisoning the new store", async () => temporary((agentDir) => {
	const transcriptDir = join(agentDir, "extensions", "pi-claude-transcript");
	mkdirSync(transcriptDir, { recursive: true });
	writeFileSync(join(transcriptDir, "config.json"), JSON.stringify({ working: { refreshMs: "fast" } }));
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.active.working.refreshMs, 120);
	assert.equal(service.degradedError, undefined);
}));

test("statusline paths are explicitly external and cannot be written", async () => temporary((agentDir) => {
	const service = new ConfigService({ agentDir, env: {} });
	assert.throws(() => service.get("statusline.enabled"), /external settings-owned/);
	assert.throws(() => service.set("statusline.enabled", true), /unknown config path/);
}));

test("v6 imports all five fullscreen settings with exact source and CC backups, once", async () => temporary((agentDir) => {
	const pinnedDir = join(agentDir, "extensions", "pi-pinned-layout");
	const ccDir = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(pinnedDir, { recursive: true });
	mkdirSync(ccDir, { recursive: true });
	const pinnedPath = join(pinnedDir, "config.json");
	const ccPath = join(ccDir, "config.json");
	const layout = { enabled: false, stickyUserMessage: false, floatAutocomplete: false, popupGap: 7, minViewportRows: 12 };
	const bytes = `  ${JSON.stringify({ schemaVersion: 1, overrides: { ...layout, align: "top", mouse: false } })}\r\n`;
	const ccBytes = JSON.stringify({ schemaVersion: 5, revision: 4, overrides: {} });
	writeFileSync(pinnedPath, bytes);
	writeFileSync(ccPath, ccBytes);
	writeFileSync(join(agentDir, "pi-pinned-layout.json"), JSON.stringify({ popupGap: 99 }));
	const first = new ConfigService({ agentDir, env: {} });
	assert.deepEqual(first.active.layout, layout);
	assert.equal(first.degradedError, undefined);
	assert.equal(readFileSync(pinnedPath, "utf8"), bytes);
	assert.equal(readFileSync(`${pinnedPath}.cc-style-v6.bak`, "utf8"), bytes);
	assert.equal(readFileSync(`${ccPath}.schema-v5.bak`, "utf8"), ccBytes);
	assert.equal(first.diagnostics().migration?.sources[0]?.path, pinnedPath);
	writeFileSync(pinnedPath, JSON.stringify({ overrides: { popupGap: 99 } }));
	const second = new ConfigService({ agentDir, env: {} });
	assert.deepEqual(second.active.layout, layout);
	assert.deepEqual(second.diagnostics().migration, first.diagnostics().migration);
	assert.equal(second.revision, first.revision);
	assert.equal(readFileSync(`${pinnedPath}.cc-style-v6.bak`, "utf8"), bytes);
}));

test("v6 preserves CC overrides and skips invalid legacy Pinned values", async () => temporary((agentDir) => {
	const ccDir = join(agentDir, "extensions", "pi-claude-style");
	mkdirSync(ccDir, { recursive: true });
	writeFileSync(join(ccDir, "config.json"), JSON.stringify({ schemaVersion: 5, revision: 1,
		overrides: { layout: { popupGap: 3, enabled: true } } }));
	const pinnedPath = join(agentDir, "pi-pinned-layout.json");
	const bytes = JSON.stringify({ enabled: false, popupGap: 9, stickyUserMessage: "yes", floatAutocomplete: false, minViewportRows: -1 });
	writeFileSync(pinnedPath, bytes);
	const service = new ConfigService({ agentDir, env: {} });
	assert.equal(service.degradedError, undefined);
	assert.deepEqual(service.active.layout, { enabled: true, popupGap: 3, stickyUserMessage: true, floatAutocomplete: false, minViewportRows: 4 });
	assert.equal(readFileSync(`${pinnedPath}.cc-style-v6.bak`, "utf8"), bytes);
}));
