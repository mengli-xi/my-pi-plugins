import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";

type CustomComponent = Component & { dispose?(): void };

interface CustomSession {
	component?: CustomComponent;
	close(): void;
}

const INPUT = {
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\u001b",
	"ctrl+c": "\u0003",
} as const;

// Host only the public custom-UI contract. The installed kit still owns rendering,
// navigation, actions, and pending-work draining; no kit testing subpath is required.
export function createTuiHarness(options: { width: number; rows: number }) {
	let width = options.width;
	let opening = deferred<void>();
	let active: CustomSession | undefined;
	let latestClosed: Promise<unknown> | undefined;
	const tui = {
		terminal: {
			get columns() {
				return width;
			},
			rows: options.rows,
		},
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: unknown, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	// Standard menu screens use only public TUI bindings; never load user bindings.
	const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

	const custom: ExtensionContext["ui"]["custom"] = async <Value>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (value: Value) => void,
		) => CustomComponent | Promise<CustomComponent>,
		customOptions?: unknown,
	): Promise<Value> => {
		if (customOptions !== undefined) throw new Error("Goal test harness does not host overlays");
		if (active) throw new Error("Goal test harness already has an active component");
		const opened = opening;
		const closed = deferred<Value>();
		latestClosed = closed.promise;
		let component: CustomComponent | undefined;
		let settled = false;
		let disposed = false;
		function disposeComponent() {
			if (!component || disposed) return;
			disposed = true;
			component.dispose?.();
		}
		function finish(value: Value) {
			if (settled) return;
			settled = true;
			if (active === session) active = undefined;
			opening = deferred<void>();
			closed.resolve(value);
			disposeComponent();
		}
		const session: CustomSession = { close: () => finish(undefined as Value) };
		active = session;
		try {
			component = await factory(tui, theme, keybindings, finish);
			session.component = component;
			if (settled) {
				opened.reject(new Error("Goal custom component closed before opening"));
			} else {
				opened.resolve();
			}
			return await closed.promise;
		} catch (error) {
			opened.reject(error);
			closed.reject(error);
			throw error;
		} finally {
			if (active === session) active = undefined;
			disposeComponent();
		}
	};

	function render(renderWidth = width) {
		if (!active?.component) throw new Error("Goal test harness has no open component");
		width = renderWidth;
		return active.component.render(width);
	}

	return {
		custom,
		waitForOpen: () => opening.promise,
		// Wait for the real done callback, not a guessed microtask delay or a private
		// component method. runMenu drains pending work before opening the next screen.
		waitForClose() {
			if (!latestClosed) throw new Error("Goal test harness has not opened a component");
			return latestClosed;
		},
		render,
		press(key: keyof typeof INPUT) {
			const component = active?.component;
			if (!component) throw new Error("Goal test harness has no open component");
			component.handleInput?.(INPUT[key]);
		},
		dispose() {
			active?.close();
		},
	};
}

function deferred<Value>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<Value>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	// Keep host failures observable to waiters without an unhandled rejection when
	// runMenu has already reported the same custom-UI failure to its caller.
	void promise.catch(() => undefined);
	return { promise, resolve, reject };
}
