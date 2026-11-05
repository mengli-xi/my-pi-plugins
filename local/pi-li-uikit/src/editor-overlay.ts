import type {
	Component,
	Focusable,
	OverlayOptions,
	TUI,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";

interface EditorLike extends Component {
	getText(): string;
	setText(text: string): void;
	handleInput(data: string): void;
}

interface ScreenPositionHost extends Component {
	setScreenOrigin(row: number, column: number): void;
}

interface AvailableHeightHost extends Component {
	setAvailableHeight(rows: number): void;
}

interface DisposableComponent extends Component {
	dispose?(): void;
}

function childrenOf(component: Component): readonly Component[] {
	const children = (component as { children?: unknown }).children;
	return Array.isArray(children) ? children as readonly Component[] : [];
}

function containsEditor(root: Component, depth = 8): boolean {
	const candidate = root as Partial<EditorLike>;
	if (
		typeof candidate.getText === "function" &&
		typeof candidate.setText === "function" &&
		typeof candidate.handleInput === "function"
	) return true;
	if (depth <= 0) return false;
	return childrenOf(root).some((child) => containsEditor(child, depth - 1));
}

function editorRoot(roots: readonly Component[]): Component | undefined {
	for (let index = roots.length - 1; index >= 0; index--) {
		const root = roots[index];
		if (root && containsEditor(root)) return root;
	}
	return undefined;
}

function renderedHeight(component: Component, width: number): number {
	try {
		return component.render(width).length;
	} catch {
		return 0;
	}
}

const EDITOR_SLOT_GEOMETRY_KEY = Symbol.for("pi.pinned-layout.editor-slot-geometry.v1");

interface EditorSlotGeometryV1 {
	version: 1;
	width: number;
	bottomMargin: number;
	availableHeight: number;
}

interface EditorSlotResolverV1 {
	version: 1;
	snapshot(tui: TUI): EditorSlotGeometryV1 | undefined;
}

interface EditorSlotRegistryV1 {
	version: 1;
	resolvers: Set<EditorSlotResolverV1>;
}

function providedGeometry(tui: TUI): EditorSlotGeometryV1 | undefined {
	const value = (globalThis as Record<PropertyKey, unknown>)[EDITOR_SLOT_GEOMETRY_KEY];
	if (
		typeof value !== "object" || value === null
		|| (value as { version?: unknown }).version !== 1
		|| !((value as { resolvers?: unknown }).resolvers instanceof Set)
	) return undefined;
	const registry = value as EditorSlotRegistryV1;
	const candidates: Array<() => EditorSlotGeometryV1 | undefined> = [];
	if (registry.resolvers instanceof Set) {
		for (const resolver of registry.resolvers) {
			if (resolver?.version === 1 && typeof resolver.snapshot === "function") {
				candidates.push(() => resolver.snapshot(tui));
			}
		}
	}
	for (const candidate of candidates) {
		try {
			const snapshot = candidate();
			if (
				!snapshot || snapshot.version !== 1
				|| !Number.isFinite(snapshot.width) || snapshot.width < 1
				|| !Number.isFinite(snapshot.bottomMargin) || snapshot.bottomMargin < 0
				|| !Number.isFinite(snapshot.availableHeight) || snapshot.availableHeight < 1
			) continue;
			return snapshot;
		} catch {}
	}
	return undefined;
}

/** Geometry shared by every panel that visually occupies Pi's editor slot. */
export interface EditorOverlayPlacement {
	readonly options: OverlayOptions;
	availableHeight(): number;
	origin(fullHeight: number): { row: number; column: number };
}

/**
 * Keep an overlay's bottom edge where a non-overlay `ui.custom()` component
 * would end: immediately before below-editor widgets and Pi's footer. The
 * editor root is captured before the overlay takes focus; trailing root heights
 * stay live so statusline/footer changes do not move the panel off its slot.
 */
export function resolveEditorOverlayPlacement(tui: TUI): EditorOverlayPlacement {
	const roots = Array.isArray(tui.children) ? tui.children : [];
	const root = editorRoot(roots);
	const rootIndex = root ? roots.indexOf(root) : -1;

	const width = (): number => {
		const columns = tui.terminal?.columns;
		return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
	};
	const fallbackTrailingRows = (): number => {
		if (rootIndex < 0) return 0;
		const currentWidth = width();
		return roots
			.slice(rootIndex + 1)
			.reduce((rows, component) => rows + renderedHeight(component, currentWidth), 0);
	};
	const geometry = (): EditorSlotGeometryV1 | undefined => providedGeometry(tui);
	const trailingRows = (): number => geometry()?.bottomMargin ?? fallbackTrailingRows();

	const options: OverlayOptions = {
		anchor: "bottom-left",
		width: "100%",
		get margin() {
			return { bottom: trailingRows() };
		},
	};

	const availableHeight = (): number => {
		const exact = geometry();
		if (exact) return Math.max(1, Math.floor(exact.availableHeight));
		const rows = tui.terminal?.rows;
		const terminalRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 1;
		return Math.max(1, terminalRows - trailingRows());
	};

	return {
		options,
		availableHeight,
		origin(fullHeight) {
			const rows = tui.terminal?.rows;
			const terminalRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : fullHeight;
			return {
				// Negative means the old editor-slot view would have been clipped
				// from the top. The wrapper returns only the visible tail, while the
				// child keeps this origin for exact mouse-coordinate translation.
				row: terminalRows - trailingRows() - Math.max(0, fullHeight),
				column: 0,
			};
		},
	};
}

class EditorOverlayComponent implements Component, Focusable {
	private disposed = false;
	private origin = { row: 0, column: 0 };
	private childWidth = 0;
	private childHeight = 0;
	readonly wantsKeyRelease: boolean;
	private readonly child: DisposableComponent & Partial<Focusable> & Partial<ScreenPositionHost> & Partial<AvailableHeightHost>;
	private readonly placement: EditorOverlayPlacement;

	constructor(component: Component, placement: EditorOverlayPlacement) {
		this.child = component as DisposableComponent & Partial<Focusable> & Partial<ScreenPositionHost> & Partial<AvailableHeightHost>;
		this.placement = placement;

		this.wantsKeyRelease = (component as { wantsKeyRelease?: unknown }).wantsKeyRelease === true;
	}

	get wantsMouse(): boolean {
		return (this.child as { wantsMouse?: unknown }).wantsMouse === true;
	}

	get focused(): boolean {
		return this.child.focused === true;
	}

	set focused(value: boolean) {
		if ("focused" in this.child) this.child.focused = value;
	}

	render(width: number): string[] {
		const available = this.placement.availableHeight();
		const gapRows = available > 1 ? 1 : 0;
		const childAvailable = Math.max(1, available - gapRows);
		this.child.setAvailableHeight?.(childAvailable);
		const lines = this.child.render(width);
		const origin = this.placement.origin(lines.length);
		this.origin = origin;
		this.childWidth = width;
		this.childHeight = lines.length;
		this.child.setScreenOrigin?.(origin.row, origin.column);
		const visible = lines.length > childAvailable
			? lines.slice(lines.length - childAvailable)
			: lines;
		return gapRows > 0 ? [" ".repeat(Math.max(0, width)), ...visible] : visible;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed) return undefined;
		return this.child.handleMouse?.({
			...event, x: event.screenX - this.origin.column, y: event.screenY - this.origin.row,
			width: this.childWidth, height: this.childHeight,
		});
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.child.dispose?.();
	}
}

/** Prepare one `ctx.ui.custom()` call before its component factory runs. */
export function createEditorOverlayMount(): {
	readonly customOptions: {
		overlay: true;
		overlayOptions: () => OverlayOptions;
	};
	mount(tui: TUI, component: Component): Component;
} {
	let placement: EditorOverlayPlacement | undefined;
	return {
		customOptions: {
			overlay: true,
			overlayOptions: () => placement?.options ?? {
				anchor: "bottom-left",
				width: "100%",
				margin: { bottom: 0 },
			},
		},
		mount(tui, component) {
			placement = resolveEditorOverlayPlacement(tui);
			return new EditorOverlayComponent(component, placement);
		},
	};
}
