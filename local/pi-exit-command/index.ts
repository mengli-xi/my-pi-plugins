import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExitHandler } from "./src/restart-command.ts";

export default function exitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "复制重启命令并退出",
		handler: createExitHandler({
			argv: [...process.argv],
			execPath: process.execPath,
			cwd: process.cwd(),
			writeClipboard: copyToClipboard,
		}),
	});
}
