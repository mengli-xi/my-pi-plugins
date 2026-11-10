import { registerHooks } from "node:module";

// Unit tests use headless peer doubles; resolution of relative sources remains
// the workspace loader's responsibility. Fresh host fixtures run without this hook.
const doubles = new Map([
	["@earendil-works/pi-tui", new URL("./pi-tui.ts", import.meta.url).href],
	["@earendil-works/pi-coding-agent", new URL("./pi-coding-agent.ts", import.meta.url).href],
]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = doubles.get(specifier);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
