import { existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";

export function waitForJointGate(name: string, signal?: AbortSignal): Promise<void> {
	const path = join(process.env.GOAL_JOINT_BARRIER_DIR ?? "", name);
	return new Promise((resolve) => {
		const done = () => {
			watcher.close();
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const watcher = watch(dirname(path), () => {
			if (existsSync(path)) done();
		});
		signal?.addEventListener("abort", done, { once: true });
		if (existsSync(path) || signal?.aborted) done();
	});
}

/** The real Process writes its fact only after the runner releases this gate. */
export function jointProcessCommand(name: string, marker: string, monitor = false) {
	const directory = process.env.GOAL_JOINT_BARRIER_DIR ?? "";
	const code = `const fs=require("node:fs"),path=require("node:path");const dir=${JSON.stringify(directory)};let sent=false;const check=()=>{if(fs.existsSync(path.join(dir,"stop")))process.exit(0);if(!sent&&fs.existsSync(path.join(dir,${JSON.stringify(name)}))){sent=true;console.log(${JSON.stringify(marker)});${monitor ? "" : "watcher.close();"}}};const watcher=fs.watch(dir,check);check();`;
	return `node -e '${code.replaceAll("'", "'\\''")}'`;
}
