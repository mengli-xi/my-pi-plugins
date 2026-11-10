import assert from "node:assert/strict";
import { Container, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { questionnaireVisibility } from "../../state/overlay-visibility.ts";
import { mustYieldInlineSlot } from "../../presentation.ts";

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	let send;
	const terminal = {
		columns: 100, rows: 30, kittyProtocolActive: false,
		start(input) { send = input; },
		stop() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {},
		setProgress() {}, setProgramStatus() {}, async drainInput() {},
	};
	const tui = new Renderer(terminal);
	const slot = new Container();
	const editorKeys = [];
	const editor = { render: () => ["EDITOR"], invalidate() {}, handleInput: (key) => editorKeys.push(key) };
	slot.addChild(editor);
	tui.addChild(slot);
	tui.setFocus(editor);
	assert.equal(mustYieldInlineSlot(tui), false);
	const passive = tui.showOverlay({ render: () => ["STATUS"], invalidate() {} }, { nonCapturing: true });
	assert.equal(mustYieldInlineSlot(tui), false, "a passive overlay leaves the inline editor slot usable");
	passive.hide();
	const capturing = tui.showOverlay({ render: () => ["DIALOG"], invalidate() {}, handleInput() {} });
	assert.equal(mustYieldInlineSlot(tui), true, "a capturing overlay requires a stacked questionnaire");
	capturing.hide();
	const askKeys = [];
	let askRenders = 0;
	const ask = {
		render() { askRenders++; return Array(25).fill("QUESTIONNAIRE"); },
		invalidate() {}, handleInput: (key) => askKeys.push(key),
	};
	const visible = questionnaireVisibility(tui, ask);
	const handle = tui.showOverlay(ask, { visible, anchor: "bottom-center", width: "100%" });
	const dialogs = [];
	const showTop = () => {
		const top = dialogs.at(-1) ?? editor;
		slot.clear(); slot.addChild(top); tui.setFocus(top); tui.requestRender();
	};
	function confirm({ signal, timeout } = {}) {
		let resolve;
		const result = new Promise((done) => { resolve = done; });
		let timer;
		const finish = (value) => {
			clearTimeout(timer); signal?.removeEventListener("abort", abort);
			const index = dialogs.indexOf(dialog);
			if (index < 0) return;
			dialogs.splice(index, 1); if (index === dialogs.length) showTop(); resolve(value);
		};
		const abort = () => finish(false);
		const dialog = {
			render: () => ["VISIBLE_CONFIRM"], invalidate() {},
			handleInput: (key) => { if (key === "\r") finish(true); },
		};
		dialogs.push(dialog); signal?.addEventListener("abort", abort, { once: true });
		if (timeout) timer = setTimeout(abort, timeout);
		showTop();
		return result;
	}
	const paint = () => tui.renderNow(true);
	try {
		tui.start(); paint();
		assert.ok(askRenders > 0);
		const answered = confirm();
		assert.equal(visible(), false);
		assert.equal(tui.hasOverlay(), false, "ask must yield its entire visual layer");
		const before = askRenders; paint();
		assert.equal(askRenders, before, "a native confirm cannot be painted underneath ask");
		send("\r");
		assert.equal(await answered, true);
		assert.deepEqual(askKeys, [], "Enter must only reach the visible confirm");
		assert.equal(visible(), true); paint();
		assert.ok(askRenders > before, "ask must return without another keypress");
		send("after-confirm");
		assert.equal(tui.getFocusedComponent(), ask);
		assert.deepEqual(askKeys, ["after-confirm"]);
		assert.deepEqual(editorKeys, [], "the first key after close must return to ask");

		const lower = confirm(); const upper = confirm();
		send("\r"); assert.equal(await upper, true);
		assert.equal(visible(), false, "closing an upper dialog must leave the lower one visible");
		send("\r"); assert.equal(await lower, true);
		assert.equal(visible(), true);
		send("after-nested"); assert.equal(tui.getFocusedComponent(), ask);

		for (const cancellation of ["abort", "timeout"]) {
			const controller = new AbortController();
			const pending = confirm(cancellation === "abort" ? { signal: controller.signal } : { timeout: 10 });
			assert.equal(visible(), false);
			if (cancellation === "abort") controller.abort();
			assert.equal(await pending, false);
			assert.equal(visible(), true, `${cancellation} must restore ask without input`);
			paint(); send(`after-${cancellation}`);
			assert.equal(tui.getFocusedComponent(), ask);
		}

		handle.setHidden(true);
		const collapsed = confirm();
		assert.equal(visible(), false, "collapse shortcut must yield while another dialog owns focus");
		send("\r"); await collapsed;
		assert.equal(handle.isHidden(), true, "automatic suspension must preserve manual collapse");
		assert.equal(tui.hasOverlay(), false);
		handle.setHidden(false);
		assert.equal(tui.getFocusedComponent(), ask);
		assert.equal(tui.hasOverlay(), true);

		const upperOverlay = { render: () => ["UPPER_OVERLAY"], invalidate() {}, handleInput() {} };
		const upperHandle = tui.showOverlay(upperOverlay);
		assert.equal(visible(), false);
		upperHandle.hide();
		assert.equal(visible(), true);
		assert.equal(tui.getFocusedComponent(), ask);
	} finally {
		handle.hide(); tui.stop();
	}
}
