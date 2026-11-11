import { basename } from "node:path";

/**
 * 重放会换掉当前会话或换掉输出模式的开关：整个丢弃。
 * 与 Pi 1.5 `dist/cli/args.js` 的 `parseArgs` 一一对应。
 */
const OMITTED_FLAGS = new Set([
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--no-session",
	"--help",
	"-h",
	"--version",
	"-v",
]);

/** 重放时由当前 session 文件代替的参数；连同它的值一起丢弃。 */
const OMITTED_VALUE_FLAGS = new Set([
	"--session",
	"--session-id",
	"--fork",
	"--mode",
	"--export",
]);

/** Pi 1.5 中带一个值的启动参数：值原样保留。 */
const VALUE_FLAGS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--name",
	"-n",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--use-theme",
	"--tui-mode",
]);

/** Pi 1.5 中的布尔启动参数：原样保留。 */
const BOOLEAN_FLAGS = new Set([
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
]);

/**
 * `/exit` 只用到这几项。Pi 的 `ExtensionCommandContext` 结构上满足它，
 * 注册处的类型检查会保证这一点。
 */
export interface ExitContext {
	sessionManager: {
		getSessionFile(): string | undefined;
	};
	ui: {
		notify(message: string, type: "error"): void;
	};
	shutdown(): void;
}

export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 去掉运行时自己那一段：`node <script>`/`bun <script>` 跳过两个前缀，
 * bun 编译版把入口放在 `/$bunfs/root/` 下，同样跳过。
 */
function launchArguments(argv: readonly string[], execPath: string): string[] {
	const executable = basename(execPath).toLowerCase();
	const genericRuntime = /^(?:bun|node)(?:\.exe)?$/u.test(executable);
	const script = argv[1];
	if (genericRuntime || script?.startsWith("/$bunfs/root/")) return argv.slice(2);
	return argv.slice(1);
}

function retainedLaunchOptions(args: readonly string[]): string[] {
	const retained: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;

		// `--` 之后全是消息与 @文件，已经提交给会话，不再重放。
		if (arg === "--") break;

		if (OMITTED_FLAGS.has(arg)) continue;
		if (OMITTED_VALUE_FLAGS.has(arg)) {
			if (index + 1 >= args.length) throw new Error(`${arg} 缺少参数值`);
			index++;
			continue;
		}

		if (VALUE_FLAGS.has(arg)) {
			const value = args[index + 1];
			if (value === undefined) throw new Error(`${arg} 缺少参数值`);
			retained.push(arg, value);
			index++;
			continue;
		}

		if (arg === "--print" || arg === "-p") {
			const prompt = args[index + 1];
			if (
				prompt !== undefined &&
				!prompt.startsWith("@") &&
				(!prompt.startsWith("-") || prompt.startsWith("---"))
			) {
				index++;
			}
			continue;
		}

		if (BOOLEAN_FLAGS.has(arg)) {
			retained.push(arg);
			continue;
		}

		if (arg === "--list-models") {
			const value = args[index + 1];
			if (value !== undefined && !value.startsWith("-") && !value.startsWith("@")) index++;
			continue;
		}

		if (arg.startsWith("--")) {
			retained.push(arg);
			if (!arg.includes("=")) {
				const value = args[index + 1];
				if (value !== undefined && !value.startsWith("-") && !value.startsWith("@")) {
					retained.push(value);
					index++;
				}
			}
			continue;
		}

		if (arg.startsWith("-")) {
			throw new Error(`不支持的启动参数：${arg}`);
		}

		// 位置消息和 @文件已经提交给会话，重放会多跑一轮模型。
	}

	return retained;
}

/**
 * 生成一条 shell 命令：回到原目录，用保留的启动参数接着当前 session 打开 Pi。
 * 命令名固定为 `pi`，与用户平时启动的方式一致；`pi` 需在 PATH 上。
 */
export function buildRestartCommand(input: {
	argv: readonly string[];
	execPath: string;
	cwd: string;
	sessionFile: string;
}): string {
	const args = retainedLaunchOptions(launchArguments(input.argv, input.execPath));
	const invocation = ["pi", ...args, "--session", input.sessionFile]
		.map(shellQuote)
		.join(" ");
	return `cd -- ${shellQuote(input.cwd)} && ${invocation}`;
}

export function createExitHandler(input: {
	argv: readonly string[];
	execPath: string;
	cwd: string;
	writeClipboard(text: string): Promise<void>;
}): (_args: string, ctx: ExitContext) => Promise<void> {
	return async (_args, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("无法重启：当前会话没有 session 文件（临时会话或未保存）", "error");
			return;
		}

		try {
			const command = buildRestartCommand({
				argv: input.argv,
				execPath: input.execPath,
				cwd: input.cwd,
				sessionFile,
			});
			await input.writeClipboard(command);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`无法复制重启命令：${message}`, "error");
			return;
		}

		ctx.shutdown();
	};
}
