import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildRestartCommand,
	type ExitContext,
	createExitHandler,
	shellQuote,
} from "../src/restart-command.ts";

const NODE = "/usr/local/bin/node";
const CLI = "/repo/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const SESSION = "/home/u/.pi/sessions/2025_ab.jsonl";

/** node 从 CLI 脚本启动时的 argv：[node, script, ...启动参数]。 */
function nodeArgv(...args: string[]): string[] {
	return [NODE, CLI, ...args];
}

/** bun 编译版 `pi` 的 argv：[可执行文件, /$bunfs 入口, ...启动参数]。 */
function compiledArgv(...args: string[]): string[] {
	return ["/home/u/.local/bin/pi", "/$bunfs/root/pi", ...args];
}

function command(
	argv: string[],
	input: { execPath?: string; cwd?: string } = {},
): string {
	return buildRestartCommand({
		argv,
		execPath: input.execPath ?? NODE,
		cwd: input.cwd ?? "/work/repo",
		sessionFile: SESSION,
	});
}

test("node 启动：跳过 node 与脚本两段，保留其余参数", () => {
	assert.equal(
		command(nodeArgv("--provider", "anthropic", "--model", "sonnet", "帮我看看")),
		`cd -- /work/repo && pi --provider anthropic --model sonnet --session ${SESSION}`,
	);
});

test("bun 启动：同样跳过运行时与脚本两段", () => {
	assert.equal(
		command(["/home/u/.bun/bin/bun", CLI, "--model", "gpt-5"], { execPath: "/home/u/.bun/bin/bun" }),
		`cd -- /work/repo && pi --model gpt-5 --session ${SESSION}`,
	);
});

test("bun 编译版：跳过可执行文件与 /$bunfs 入口", () => {
	assert.equal(
		command(compiledArgv("--model", "gpt-5", "帮我看看"), { execPath: "/home/u/.local/bin/pi" }),
		`cd -- /work/repo && pi --model gpt-5 --session ${SESSION}`,
	);
});

test("丢弃会换会话、换输出模式或启动后即退出的参数", () => {
	const argv = nodeArgv(
		"--model", "sonnet",
		"--continue", "-c",
		"--resume", "-r",
		"--session", "/home/u/.pi/sessions/other.jsonl",
		"--session-id", "abc123",
		"--fork", "abc123",
		"--mode", "json",
		"--export", "out.html", "report.html",
		"--no-session",
		"--help", "-h",
		"--version", "-v",
		"--print", "提示词",
		"-p",
		"--list-models", "sonnet",
		"位置消息",
		"@notes.md",
	);
	assert.equal(command(argv), `cd -- /work/repo && pi --model sonnet --session ${SESSION}`);
});

test("-- 之后的位置参数与 @文件不重放", () => {
	assert.equal(
		command(nodeArgv("--model", "sonnet", "--", "--model", "gpt-5", "位置消息", "@notes.md")),
		`cd -- /work/repo && pi --model sonnet --session ${SESSION}`,
	);
});

test("保留 Pi 1.5 的带值启动参数", () => {
	const pairs: Array<[string, string]> = [
		["--provider", "anthropic"],
		["--model", "sonnet"],
		["--api-key", "sk-test"],
		["--system-prompt", "be-brief"],
		["--append-system-prompt", "./rules.md"],
		["--name", "refactor"],
		["-n", "refactor-2"],
		["--session-dir", "/home/u/.pi/sessions"],
		["--models", "anthropic/gpt"],
		["--tools", "read,bash"],
		["-t", "+edit"],
		["--exclude-tools", "write"],
		["-xt", "mcp__x"],
		["--thinking", "high"],
		["--extension", "/repo/local/pi-exit-command"],
		["-e", "./extra.ts"],
		["--skill", "./skills"],
		["--prompt-template", "./prompts"],
		["--theme", "./themes"],
		["--use-theme", "dark"],
		["--tui-mode", "regular"],
	];
	const args = pairs.flat();
	assert.equal(
		command(nodeArgv(...args)),
		`cd -- /work/repo && pi ${args.join(" ")} --session ${SESSION}`,
	);
});

test("保留 Pi 1.5 的布尔启动参数，且不吞掉后面的位置参数", () => {
	const flags = [
		"--no-tools",
		"-nt",
		"--no-builtin-tools",
		"-nbt",
		"--no-extensions",
		"-ne",
		"--no-mcp",
		"--no-skills",
		"-ns",
		"--no-prompt-templates",
		"-np",
		"--no-themes",
		"--no-context-files",
		"-nc",
		"--verbose",
		"--approve",
		"-a",
		"--no-approve",
		"-na",
		"--offline",
	];
	assert.equal(
		command(nodeArgv(...flags.flatMap((flag) => [flag, "位置消息"]))),
		`cd -- /work/repo && pi ${flags.join(" ")} --session ${SESSION}`,
	);
});

test("带值参数缺少值时抛错", () => {
	assert.throws(() => command(nodeArgv("--model")), /--model 缺少参数值/u);
	assert.throws(() => command(nodeArgv("--session")), /--session 缺少参数值/u);
});

test("不认识的短参数抛错，不猜它的语义", () => {
	assert.throws(() => command(nodeArgv("-z", "x")), /不支持的启动参数：-z/u);
});

test("未知长参数视为扩展注册的 flag，按 Pi 的规则连带取值", () => {
	assert.equal(
		command(nodeArgv("--my-flag", "value")),
		`cd -- /work/repo && pi --my-flag value --session ${SESSION}`,
	);
	assert.equal(
		command(nodeArgv("--my-flag=value")),
		`cd -- /work/repo && pi --my-flag=value --session ${SESSION}`,
	);
	assert.equal(
		command(nodeArgv("--my-switch")),
		`cd -- /work/repo && pi --my-switch --session ${SESSION}`,
	);
	// Pi 的未知 flag 解析把紧跟的非 - 参数当值；重放时保持同一读法。
	assert.equal(
		command(nodeArgv("--my-switch", "位置消息")),
		`cd -- /work/repo && pi --my-switch '位置消息' --session ${SESSION}`,
	);
});

test("shell 元字符按单引号转义", () => {
	assert.equal(shellQuote("/work/repo"), "/work/repo");
	assert.equal(shellQuote("/work/my repo"), "'/work/my repo'");
	assert.equal(shellQuote("/work/it's$HOME"), `'/work/it'\\''s$HOME'`);
	assert.equal(
		command(nodeArgv("--name", "it's"), { cwd: "/work/my repo" }),
		`cd -- '/work/my repo' && pi --name 'it'\\''s' --session ${SESSION}`,
	);
});

function fakeContext(sessionFile: string | undefined): ExitContext & {
	notifications: Array<[string, string]>;
	shutdowns: number;
} {
	const notifications: Array<[string, string]> = [];
	const state = { shutdowns: 0 };
	return {
		notifications,
		get shutdowns() {
			return state.shutdowns;
		},
		sessionManager: { getSessionFile: () => sessionFile },
		ui: {
			notify(message: string, type: "error") {
				notifications.push([message, type]);
			},
		},
		shutdown() {
			state.shutdowns++;
		},
	};
}

test("临时会话报错，不写剪贴板也不退出", async () => {
	const ctx = fakeContext(undefined);
	let copied = 0;
	const handler = createExitHandler({
		argv: nodeArgv("--model", "sonnet"),
		execPath: NODE,
		cwd: "/work/repo",
		writeClipboard: async () => {
			copied++;
		},
	});
	await handler("", ctx);
	assert.equal(copied, 0);
	assert.equal(ctx.shutdowns, 0);
	assert.equal(ctx.notifications.length, 1);
	assert.equal(ctx.notifications[0]![1], "error");
	assert.match(ctx.notifications[0]![0], /无法重启/u);
});

test("剪贴板失败时提示并留在 Pi 里", async () => {
	const ctx = fakeContext(SESSION);
	const handler = createExitHandler({
		argv: nodeArgv(),
		execPath: NODE,
		cwd: "/work/repo",
		writeClipboard: () => Promise.reject(new Error("pbcopy 不可用")),
	});
	await handler("", ctx);
	assert.equal(ctx.shutdowns, 0);
	assert.equal(ctx.notifications.length, 1);
	assert.match(ctx.notifications[0]![0], /无法复制重启命令：pbcopy 不可用/u);
});

test("命令行构建失败时同样提示，不退出", async () => {
	const ctx = fakeContext(SESSION);
	let copied = 0;
	const handler = createExitHandler({
		argv: nodeArgv("-z"),
		execPath: NODE,
		cwd: "/work/repo",
		writeClipboard: async () => {
			copied++;
		},
	});
	await handler("", ctx);
	assert.equal(copied, 0);
	assert.equal(ctx.shutdowns, 0);
	assert.match(ctx.notifications[0]![0], /不支持的启动参数：-z/u);
});

test("复制成功后正常退出", async () => {
	const ctx = fakeContext(SESSION);
	const copied: string[] = [];
	const handler = createExitHandler({
		argv: nodeArgv("--model", "sonnet", "旧提示词"),
		execPath: NODE,
		cwd: "/work/repo",
		writeClipboard: async (text) => {
			copied.push(text);
		},
	});
	await handler("", ctx);
	assert.deepEqual(copied, [
		`cd -- /work/repo && pi --model sonnet --session ${SESSION}`,
	]);
	assert.equal(ctx.shutdowns, 1);
	assert.equal(ctx.notifications.length, 0);
});
