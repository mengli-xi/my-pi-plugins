import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPiVersion } from "../../../scripts/pi-checks.mjs";
import { isolatedEnvironment, stockHost } from "./runtime-test-env.mjs";

// Fresh stock Pi smoke of the compiled Goal entry and real mailbox transport.
const root = await mkdtemp(join(tmpdir(), "goal-mailbox-faux-"));
const output = process.argv[2] ? resolve(process.argv[2]) : root;
await mkdir(output, { recursive: true });
for (const name of ["home", "agent", "cwd", "tmp"]) await mkdir(join(root, name));
const log = join(root, "events.jsonl");
await writeFile(log, "");
const bundle = resolve(fileURLToPath(new URL("../dist/index.js", import.meta.url)));
const fauxPath = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
const fixture = `
import {appendFileSync} from 'node:fs';
import goal from ${JSON.stringify(bundle)};
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(fauxPath)};
const record=value=>appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
export default function(pi){
 const faux=fauxProvider({provider:'goal-mailbox-faux',api:'goal-mailbox-faux',models:[{id:'fixture',reasoning:false,contextWindow:32768,maxTokens:512}],tokensPerSecond:1000000});
 faux.setResponses([async(context,opts,state)=>{record({request:state.callCount,messages:context.messages});return fauxAssistantMessage('First pass needs a continuation.');},async(context,opts,state)=>{record({request:state.callCount,messages:context.messages});const text=context.messages.map(message=>typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(part=>part.type==='text').map(part=>part.text).join('\\n'):'').join('\\n'),id=[...text.matchAll(/<goal_id>\\s*([^<\\s]+)\\s*<\\/goal_id>/g)].at(-1)?.[1];if(!id)throw Error('missing Goal context');return fauxAssistantMessage(fauxToolCall('goal_complete',{goal_id:id,summary:'Completed the isolated adapter smoke.'}));}]);
 pi.registerProvider(faux.provider);
 goal(pi);
 pi.registerCommand('goal-smoke-inspect',{handler:async(_args,context)=>{const slot=[...(globalThis[Symbol.for('pi.session-inject.mailbox.v1')]?.slots.values()??[])].find(slot=>slot.session.id===context.sessionManager.getSessionId());record({stage:'transport',recoveryHeld:slot?.recoveryHeld,suspended:slot?.snapshot.suspended,pending:slot?.snapshot.pending.map(record=>({key:record.key,policy:record.policy,wake:record.wake})),calls:faux.state.callCount});}});
 pi.on('agent_settled',(_event,context)=>{const branch=context.sessionManager.getBranch(),last=branch.filter(x=>x.type==='custom'&&x.customType==='goal-state').at(-1);record({settled:true,calls:faux.state.callCount,goal:last?.data?.goal??null,bodies:branch.filter(x=>x.type==='custom_message'&&x.customType==='goal-mailbox-continuation-v1').length,controls:branch.filter(x=>x.type==='custom_message'&&x.customType==='agent-mailbox-trigger-v1').length});});
}
`;
await writeFile(join(root, "fixture.ts"), fixture);
await writeFile(
	join(root, "agent/settings.json"),
	JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }),
);
const env = isolatedEnvironment(root);
const { binary, version: hostVersion } = stockHost(env);
assert.equal(hostVersion, installedPiVersion(), "CLI must match the installed SDK");
const child = spawn(
	binary,
	[
		"--mode",
		"rpc",
		"--offline",
		"--approve",
		"-ne",
		"--no-mcp",
		"-ns",
		"-np",
		"-nc",
		"--no-themes",
		"-e",
		join(root, "fixture.ts"),
		"--provider",
		"goal-mailbox-faux",
		"--model",
		"fixture",
		"--thinking",
		"off",
	],
	{
		cwd: join(root, "cwd"),
		env,
		stdio: ["pipe", "pipe", "pipe"],
	},
);
let stdout = "",
	stderr = "";
child.stdout.on("data", (data) => {
	stdout += data;
});
child.stderr.on("data", (data) => {
	stderr += data;
});
const exited = new Promise((done) => child.on("close", (code) => done(code)));
child.stdin.write(
	`${JSON.stringify({ type: "prompt", id: "start", message: "/goal run the isolated Goal mailbox adapter smoke" })}\n`,
);
let rows = [];
let inspected = false;
let settledAt;
try {
	const deadline = Date.now() + 10000;
	while (!rows.some((row) => row.settled && row.calls === 2 && row.goal === null)) {
		if (Date.now() > deadline || child.exitCode !== null)
			throw Error(`smoke did not settle: ${stdout.slice(-2000)}\n${stderr}`);
		if (rows.some((row) => row.settled && row.calls === 1) && !settledAt) settledAt = Date.now();
		if (!inspected && settledAt && Date.now() - settledAt > 1000) {
			inspected = true;
			child.stdin.write(
				`${JSON.stringify({ type: "prompt", id: "inspect", message: "/goal-smoke-inspect" })}\n`,
			);
		}
		await new Promise((done) => setTimeout(done, 20));
		rows = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
	}
	child.stdin.end();
	assert.equal(await exited, 0);
	const final = rows.filter((row) => row.settled).at(-1);
	assert.equal(final.bodies, 1);
	assert.equal(final.controls, 1);
	assert.equal(final.calls, 2);
	const requests = rows.filter((row) => row.request);
	assert.equal(requests.length, 2);
	assert.ok(JSON.stringify(requests[1].messages).includes("pi-goal-continuation:"));
	await writeFile(join(output, "rpc.jsonl"), stdout);
	assert.ok(
		!stdout.includes('"type":"extension_error"'),
		stdout
			.split("\n")
			.filter((line) => line.includes('"type":"extension_error"'))
			.join("\n"),
	);
	assert.ok(
		!stdout.includes("Goal migration unknown"),
		"fixture must prove its own control membership",
	);
	const result = {
		host: `stock Pi ${hostVersion}`,
		fixture: "real A1 transport",
		compiledBundle: bundle,
		realRequests: 0,
		fauxRequests: 2,
		nativeBodies: 1,
		nativeControls: 1,
		completed: true,
	};
	await writeFile(join(output, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
	await writeFile(join(output, "rpc.jsonl"), stdout);
	await writeFile(join(output, "requests.jsonl"), await readFile(log));
	console.log(JSON.stringify(result));
} catch (error) {
	await writeFile(join(output, "rpc.jsonl"), stdout);
	await writeFile(join(output, "requests.jsonl"), await readFile(log));
	await writeFile(join(output, "failure.txt"), String(error));
	child.kill("SIGKILL");
	await exited;
	throw error;
} finally {
	if (output !== root) await rm(root, { recursive: true, force: true });
}
