import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

function runEditor(command: string, file: string, signal?: AbortSignal): Promise<void> {
	// Keep the command grammar identical to Pi's built-in external-editor flow. A
	// separate shell or argv parser here would make Ctrl+G behave differently.
	const [editor, ...args] = command.split(" ");
	if (!editor) return Promise.reject(new Error("External editor command is empty"));

	return new Promise((resolve, reject) => {
		const child = spawn(editor, [...args, file], {
			stdio: "inherit",
			shell: process.platform === "win32",
			signal,
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			reject(new Error(`External editor exited with ${reason}`));
		});
	});
}

/**
 * Edit a custom answer with Pi's configured external-editor command. The TUI lifecycle
 * and one-trailing-newline normalization intentionally match Pi's main editor flow.
 */
export async function editWithExternalEditor(tui: ExternalEditorTui, command: string, value: string, signal?: AbortSignal): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	const tempDir = mkdtempSync(join(tmpdir(), "rpiv-ask-user-question-"));
	const tempFile = join(tempDir, "answer.md");
	let tuiStopped = false;
	// Complete the stop/start pair synchronously on cancellation, before the host
	// can replace the session; a late child completion must never restart this TUI.
	const restore = () => {
		if (!tuiStopped) return;
		tuiStopped = false;
		tui.start();
		tui.requestRender(true);
	};

	try {
		writeFileSync(tempFile, value, "utf8");
		tui.stop();
		tuiStopped = true;
		signal?.addEventListener("abort", restore, { once: true });
		if (signal?.aborted) { restore(); return undefined; }
		process.stdout.write(`Launching external editor: ${command}\nPi will resume when the editor exits.\n`);
		await runEditor(command, tempFile, signal);
		if (signal?.aborted) return undefined;
		return readFileSync(tempFile, "utf8").replace(/\r?\n$/, "");
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort; never leave the TUI stopped because it failed.
		}
		signal?.removeEventListener("abort", restore);
		restore();
	}
}
