import assert from "node:assert/strict";
import { test } from "node:test";
import {
	copyToClipboard,
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import exitCommand from "../index.ts";

interface Captured {
	name?: string;
	description?: string;
	handler?: unknown;
}

function fakePi(): { pi: ExtensionAPI; captured: Captured } {
	const captured: Captured = {};
	const pi = {
		registerCommand(name: string, options: Captured) {
			captured.name = name;
			captured.description = options.description;
			captured.handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

test("注册 /exit，并带上可执行的 handler", () => {
	const { pi, captured } = fakePi();
	exitCommand(pi);
	assert.equal(captured.name, "exit");
	assert.ok(captured.description && /重启/u.test(captured.description));
	assert.equal(typeof captured.handler, "function");
});

test("Pi 1.5 仍公开本包依赖的运行时 API", () => {
	assert.equal(typeof copyToClipboard, "function");
	assert.equal(typeof SessionManager.prototype.getSessionFile, "function");
});
