import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { CollapsibleBlock } from "pi-li-uikit/collapsible-block";
import {
  EditorPanel,
  type EditorPanelScreen,
} from "pi-li-uikit/editor-panel";
import { LevelSlider } from "pi-li-uikit/level-slider";
import {
  MultiSelectTable,
  type MultiSelectTableAction,
  type MultiSelectTableRow,
} from "pi-li-uikit/multi-select-table";
import {
  ProcessPanel,
  type ProcessPanelItem,
} from "pi-li-uikit/process-panel";
import { searchSelectScreen } from "pi-li-uikit/search-select";
import { SelectableCollapsiblePanel } from "pi-li-uikit/selectable-collapsible-panel";
import {
  nextTab,
  TabStrip,
  type TabStripItem,
} from "pi-li-uikit/tab-strip";
import { TextPanel } from "pi-li-uikit/text-panel";

type GalleryScreen = "components";
type EditorDemoScreen = "overview" | "details";
type SearchDemoScreen = "models";
type Provider = "codex" | "anthropic" | "google";
type TableRowId = "alpha" | "beta" | "gamma" | "delta";
type TableColumnId = "name" | "kind" | "status";

interface GalleryOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  onClose: () => void;
}

interface InteractiveComponent extends Component {
  handleInput?(data: string): void;
  dispose?(): void;
  focused?: boolean;
  wantsMouse?: boolean;
  setAvailableHeight?(rows: number): void;
  setScreenOrigin?(row: number, column: number): void;
}

const GALLERY_ITEMS = [
  ["text-panel", "TextPanel", "Plain or Markdown text, scrolling, selection and copy"],
  ["editor-panel", "EditorPanel", "Stack navigation, actions and editor-slot chrome"],
  ["search-select", "SearchSelect", "Searchable choice list with provider tabs"],
  ["tab-strip", "TabStrip", "State-external tabs, totals and divider hint"],
  ["level-slider", "LevelSlider", "Ordered level picker with a coloured track"],
  ["multi-select-table", "MultiSelectTable", "Aligned columns and batch selection"],
  ["process-panel", "ProcessPanel", "Searchable process list with live output details"],
  ["collapsible-block", "CollapsibleBlock", "Stable summary with bounded preview"],
  ["selectable-collapsible-panel", "SelectableCollapsiblePanel", "Selectable folded items in an open editor-slot panel"],
] as const;

const PROVIDER_TABS: readonly TabStripItem<Provider>[] = [
  { value: "codex", label: "Codex" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
];

const MODEL_CHOICES = [
  { value: "gpt-5.6-sol", label: "5.6-sol", badge: "codex", tab: "codex" },
  { value: "gpt-5.6-terra", label: "5.6-terra", badge: "codex", tab: "codex" },
  { value: "gpt-5.5-codex", label: "5.5-codex", badge: "codex", tab: "codex" },
  { value: "claude-opus-4.6", label: "Opus 4.6", badge: "anthropic", tab: "anthropic" },
  { value: "claude-sonnet-4.6", label: "Sonnet 4.6", badge: "anthropic", tab: "anthropic" },
  { value: "claude-haiku-4.5", label: "Haiku 4.5", badge: "anthropic", tab: "anthropic" },
  { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro", badge: "google", tab: "google" },
  { value: "gemini-3-flash", label: "Gemini 3 Flash", badge: "google", tab: "google" },
] as const;

const TABLE_ROWS: readonly MultiSelectTableRow<TableRowId, TableColumnId>[] = [
  { id: "alpha", cells: { name: "alpha", kind: "workspace", status: "ready" }, current: true },
  { id: "beta", cells: { name: "beta-long-name", kind: "remote", status: "running" } },
  { id: "gamma", cells: { name: "gamma", kind: "system", status: "protected" }, selectionDisabled: true, selectionDisabledReason: "system resource" },
  { id: "delta", cells: { name: "delta", kind: "workspace", status: "idle" } },
];

const DEMO_CONTENT_PADDING = 2;

/** Frame an embedded demo with the same chrome as full editor-slot panels. */
function demoTitleRule(theme: Theme, title: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const label = truncateToWidth(` ${title} `, Math.max(1, safeWidth - 4), "…");
  const fill = "─".repeat(Math.max(0, safeWidth - 2 - visibleWidth(label)));
  return truncateToWidth(
    theme.fg("accent", "──")
      + theme.fg("accent", theme.bold(label))
      + theme.fg("accent", fill),
    safeWidth,
    "…",
  );
}

function demoContentWidth(width: number): number {
  const safeWidth = Math.max(1, width);
  const padding = Math.min(DEMO_CONTENT_PADDING, Math.floor((safeWidth - 1) / 2));
  return Math.max(1, safeWidth - padding * 2);
}

function insetDemoLines(lines: readonly string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  const padding = Math.min(DEMO_CONTENT_PADDING, Math.floor((safeWidth - 1) / 2));
  const prefix = " ".repeat(padding);
  const innerWidth = demoContentWidth(width);
  return lines.map((line) => `${prefix}${truncateToWidth(line, innerWidth, "…")}`);
}

function demoFooterRule(
  theme: Theme,
  width: number,
  candidates: readonly string[],
): string {
  const safeWidth = Math.max(1, width);
  const hint = candidates.find((candidate) => visibleWidth(candidate) + 3 <= safeWidth);
  if (!hint) return theme.fg("muted", "─".repeat(safeWidth));
  const label = ` ${hint}`;
  return theme.fg(
    "muted",
    `${"─".repeat(Math.max(0, safeWidth - visibleWidth(label)))}${label}`,
  );
}

function setFocused(component: InteractiveComponent, focused: boolean): void {
  if ("focused" in component) component.focused = focused;
}

/** One ui.custom() host that swaps real UIKit components without nesting slots. */
export class UIKitGallery implements Component, Focusable {
  private readonly options: GalleryOptions;
  private readonly stack: InteractiveComponent[] = [];
  private _focused = true;
  private closing = false;
  private disposed = false;

  constructor(options: GalleryOptions) {
    this.options = options;
    this.stack.push(this.componentMenu());
    setFocused(this.current, true);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    setFocused(this.current, value);
  }

  get wantsMouse(): boolean {
    return this.current.wantsMouse === true;
  }

  render(width: number): string[] {
    return this.current.render(width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this._focused || this.closing || this.disposed) return undefined;
    return this.current.handleMouse?.(event);
  }

  setAvailableHeight(rows: number): void {
    this.current.setAvailableHeight?.(rows);
  }

  handleInput(data: string): void {
    if (!this._focused || this.closing || this.disposed) return;
    this.current.handleInput?.(data);
  }

  setScreenOrigin(row: number, column: number): void {
    this.current.setScreenOrigin?.(row, column);
  }

  invalidate(): void {
    this.current.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const components = this.stack.splice(0).reverse();
    for (const component of components) {
      try {
        component.dispose?.();
      } catch {
        // Gallery teardown must not keep Pi from restoring the editor.
      }
    }
  }

  private get current(): InteractiveComponent {
    return this.stack[this.stack.length - 1]!;
  }

  private push(component: InteractiveComponent): void {
    if (this.closing || this.disposed) return;
    setFocused(this.current, false);
    this.stack.push(component);
    setFocused(component, this._focused);
    this.options.tui.requestRender();
  }

  private back = (): void => {
    if (this.closing || this.disposed) return;
    if (this.stack.length <= 1) {
      this.finish();
      return;
    }
    setFocused(this.current, false);
    const leaving = this.stack.pop();
    leaving?.dispose?.();
    setFocused(this.current, this._focused);
    this.options.tui.requestRender();
  };

  private finish = (): void => {
    if (this.closing || this.disposed) return;
    this.closing = true;
    this.options.onClose();
  };

  private componentMenu(): InteractiveComponent {
    return new EditorPanel<GalleryScreen>({
      tui: this.options.tui,
      theme: this.options.theme,
      initialScreen: "components",
      maxVisible: GALLERY_ITEMS.length,
      getScreen: () => ({
        id: "components",
        title: "UIKit gallery",
        breadcrumbs: [],
        fixedItemRows: GALLERY_ITEMS.length,
        statusLine: "Every item below opens the real pi-li-uikit component.",
        items: GALLERY_ITEMS.map(([id, label, description]) => ({
          id,
          label,
          description,
          onSelect: () => this.openDemo(id),
        })),
      }),
      onClose: this.finish,
    });
  }

  private openDemo(id: (typeof GALLERY_ITEMS)[number][0]): void {
    if (id === "text-panel") this.openTextPanel();
    else if (id === "editor-panel") this.openEditorPanel();
    else if (id === "search-select") this.openSearchSelect();
    else if (id === "tab-strip") this.openTabStrip();
    else if (id === "level-slider") this.openLevelSlider();
    else if (id === "multi-select-table") this.openMultiSelectTable();
    else if (id === "process-panel") this.openProcessPanel();
    else if (id === "collapsible-block") this.openCollapsibleBlock();
    else this.openSelectableCollapsiblePanel();
  }

  private openTextPanel(): void {
    this.push(new TextPanel({
      tui: this.options.tui,
      theme: this.options.theme,
      heading: "TextPanel",
      body: [
        "## Rich editor-slot text",
        "",
        "One component now handles both **Markdown** and plain information views.",
        "",
        "- Use `↑`/`↓`, `j`/`k`, PgUp/PgDn, Home/End to scroll.",
        "- Press `y` or `c` to copy the complete source.",
        "- Drag over rendered text to copy a selection when pinned layout is active.",
        "",
        "```ts",
        "showTextPanelComponent(ctx, createView);",
        "```",
        "",
        ...Array.from({ length: 18 }, (_, index) => `Scrollable sample line ${index + 1}.`),
      ].join("\n"),
      format: "markdown",
      overlay: { mouseScrollLines: 3 },
      placement: { anchor: "editor", marginX: 0 },
      onClose: this.back,
    }));
  }

  private openEditorPanel(): void {
    this.push(new EditorPanel<EditorDemoScreen>({
      tui: this.options.tui,
      theme: this.options.theme,
      initialScreen: "overview",
      maxVisible: 6,
      getScreen: (screen): EditorPanelScreen<string, EditorDemoScreen> =>
        screen === "details"
          ? {
              id: "details",
              title: "Nested screen",
              breadcrumbs: ["UIKit gallery", "EditorPanel"],
              statusLine: "Escape returns to the previous EditorPanel screen.",
              items: [
                { id: "back", label: "Back", description: "Pop the screen stack", transition: { kind: "back" } },
                { id: "replace", label: "Replace", description: "Replace this screen with overview", transition: { kind: "replace", screen: "overview" } },
              ],
            }
          : {
              id: "overview",
              title: "EditorPanel",
              breadcrumbs: ["UIKit gallery"],
              statusLine: "This demo has its own navigation stack.",
              items: [
                { id: "push", label: "Push nested screen", description: "A → B → Escape → A", transition: { kind: "push", screen: "details" } },
                { id: "stay", label: "Run local action", description: "Keeps the current screen", onSelect: () => undefined },
                { id: "close", label: "Return to gallery", transition: { kind: "close" } },
              ],
            },
      onClose: this.back,
    }));
  }

  private openSearchSelect(): void {
    let provider: Provider = "codex";
    let current = "gpt-5.6-sol";
    this.push(new EditorPanel<SearchDemoScreen>({
      tui: this.options.tui,
      theme: this.options.theme,
      initialScreen: "models",
      maxVisible: 6,
      getScreen: () => searchSelectScreen({
        id: "models",
        title: "SearchSelect",
        breadcrumbs: ["UIKit gallery"],
        choices: MODEL_CHOICES.map((choice) => ({
          ...choice,
          detail: `Model ID: ${choice.value}`,
          current: choice.value === current,
        })),
        initialSelected: current,
        search: true,
        statusLine: `Selected: ${current}`,
        tabs: {
          items: PROVIDER_TABS,
          selected: provider,
          onChange: (value) => {
            provider = value as Provider;
          },
          hint: "Tab/Shift+Tab providers",
        },
        onPick: (value) => {
          current = value;
        },
      }),
      onClose: this.back,
    }));
  }

  private openTabStrip(): void {
    this.push(new TabStripDemo(this.options, this.back));
  }

  private openLevelSlider(): void {
    this.push(new LevelSlider(this.options.tui, this.options.theme, {
      title: "LevelSlider",
      leftEnd: "Faster",
      rightEnd: "Smarter",
      current: "high",
      choices: [
        { value: "low", description: "Fast and concise", ansi256: 114, rgb: [120, 190, 120] },
        { value: "medium", description: "Balanced", ansi256: 180, rgb: [210, 170, 110] },
        { value: "high", description: "Deeper reasoning", ansi256: 209, rgb: [235, 135, 95] },
        { value: "xhigh", description: "Maximum care", ansi256: 204, rgb: [225, 95, 125] },
      ],
      onSelect: (value) => this.push(this.resultPanel("LevelSlider result", `Selected level: ${value}`)),
      onCancel: this.back,
    }));
  }

  private openMultiSelectTable(): void {
    const table = new MultiSelectTable<TableRowId, TableColumnId>({
      tui: this.options.tui,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      title: "MultiSelectTable",
      columns: [
        { id: "name", header: "Name", minWidth: 8 },
        { id: "kind", header: "Kind", minWidth: 7 },
        { id: "status", header: "Status", minWidth: 8 },
      ],
      rows: TABLE_ROWS,
      initialRowId: "alpha",
      maxVisible: 8,
      onAction: (action) => this.handleTableAction(action),
    });
    this.push(table);
  }

  private handleTableAction(action: MultiSelectTableAction<TableRowId>): void {
    if (action.kind === "cancel") {
      this.back();
      return;
    }
    if (action.kind === "delete") {
      this.push(this.resultPanel(
        "MultiSelectTable > delete",
        `Delete requested for: ${action.ids.join(", ")}`,
      ));
      return;
    }
    const row = TABLE_ROWS.find((candidate) => candidate.id === action.id);
    const rowTitle = row?.cells.name ?? action.id;
    const detail = `${action.kind === "inspect" ? "Inspect" : "Activate"} requested for: ${action.id}`;
    this.push(this.resultPanel(`MultiSelectTable > ${rowTitle}`, detail));
  }

  private openProcessPanel(): void {
    const startedAt = Date.now() - 3_723_000;
    let apiLive = true;
    const items = (): readonly ProcessPanelItem[] => [
      {
        id: "api",
        name: "api-server",
        kind: "service",
        status: apiLive ? "running" : "stopped",
        runtimeMs: apiLive ? Date.now() - startedAt : 3_723_000,
        command: "npm run dev",
        script: "npm run dev -- --port 3000",
        live: apiLive,
      },
      {
        id: "checks",
        name: "typecheck",
        kind: "process",
        status: "succeeded",
        runtimeMs: 18_000,
        command: "npm run typecheck",
        live: false,
      },
    ];
    this.push(new ProcessPanel({
      tui: this.options.tui,
      theme: this.options.theme,
      title: "ProcessPanel",
      listHint: "Select a process to inspect output; type to filter.",
      getItems: items,
      loadDetail: async (id) => ({
        item: items().find((item) => item.id === id)!,
        output: id === "api"
          ? [
              { text: "Server listening on http://localhost:3000" },
              { text: "GET /health 200 2ms" },
              { text: "Watching source files for changes…" },
            ]
          : [
              { text: "tsc --noEmit" },
              { text: "Typecheck completed successfully." },
            ],
        totalLines: id === "api" ? 42 : 2,
      }),
      onStop: async (id) => {
        if (id === "api") apiLive = false;
      },
      onClose: this.back,
    }));
  }

  private openCollapsibleBlock(): void {
    this.push(new CollapsibleDemo(
      this.options,
      this.back,
      () => this.push(new TextPanel({
        tui: this.options.tui,
        theme: this.options.theme,
        heading: "CollapsibleBlock source",
        body: Array.from({ length: 20 }, (_, index) => `Complete payload row ${index + 1}`).join("\n"),
        format: "plain",
        tone: "text",
        overlay: { mouseScrollLines: 3 },
        placement: { anchor: "editor", marginX: 0 },
        onClose: this.back,
      })),
    ));
  }

  private openSelectableCollapsiblePanel(): void {
    this.push(new SelectablePanelDemo(this.options, this.back));
  }

  private resultPanel(title: string, body: string): TextPanel {
    return new TextPanel({
      tui: this.options.tui,
      theme: this.options.theme,
      heading: title,
      body: `${body}\n\nPress Enter or Escape to return to the component demo.`,
      glyph: "",
      format: "plain",
      tone: "text",
      maxVisible: 5,
      overlay: { mouseScrollLines: 3 },
      placement: { anchor: "editor", marginX: 0 },
      onClose: this.back,
    });
  }
}

class SelectablePanelDemo extends SelectableCollapsiblePanel {
  private readonly items = [
    {
      id: "checks",
      summary: "Ran npm run check",
      preview: ["Typecheck passed", "✓ 1.4s"],
      details: ["Arguments", "  npm run check", "Result", "  74 tests passed"],
    },
    {
      id: "source",
      summary: "Read src/selectable-collapsible-panel.ts",
      preview: ["Open panel chrome and stable selection", "✓ 8ms"],
      details: ["Arguments", "  src/selectable-collapsible-panel.ts", "Result", "  214 lines"],
    },
  ] as const;

  constructor(options: GalleryOptions, onClose: () => void) {
    super({
      tui: options.tui,
      theme: options.theme,
      overlay: { mouseScrollLines: 3 },
      placement: { anchor: "editor", marginX: 0 },
      onClose,
    });
    this.setItemIds(this.items.map((item) => item.id));
  }

  protected title(): string {
    return "SelectableCollapsiblePanel";
  }

  protected panelFooterCandidates(): readonly string[] {
    return [
      "↑↓ select · Enter/Space/click expand/fold · jk/PgUp/PgDn scroll · Esc close",
      "↑↓ select · Enter expand/fold · jk/PgUp/PgDn scroll · Esc close",
      "↑↓ select · Enter expand/fold · Esc close",
      "Enter expand/fold · Esc close",
    ];
  }

  protected buildBody(width: number): { lines: string[]; headings: number[] } {
    const lines: string[] = [];
    const headings: number[] = [];
    this.items.forEach((item, index) => {
      headings.push(lines.length);
      lines.push(...this.renderSelectableRows(index, {
        summary: item.summary,
        expanded: this.isItemExpanded(index),
        preview: this.isItemExpanded(index) ? item.details : item.preview,
        previewLimit: this.isItemExpanded(index) ? item.details.length : 2,
        renderMarker: (marker) => this.theme.fg("dim", marker),
      }, width));
    });
    return { lines, headings };
  }
}

class TabStripDemo implements Component, Focusable {
  private readonly options: GalleryOptions;
  private readonly onClose: () => void;
  private selected: Provider = "codex";
  private _focused = true;

  constructor(options: GalleryOptions, onClose: () => void) {
    this.options = options;
    this.onClose = onClose;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const tabs = PROVIDER_TABS.map((tab) => ({
      ...tab,
      count: MODEL_CHOICES.filter((choice) => choice.tab === tab.value).length,
    }));
    const strip = new TabStrip({
      tabs,
      selected: this.selected,
      paddingX: 0,
      theme: {
        active: (text) => theme.fg("accent", theme.bold(text)),
        inactive: (text) => theme.fg("muted", text),
        hint: (text) => theme.fg("dim", text),
      },
    });
    return [
      demoTitleRule(theme, "TabStrip", width),
      "",
      ...insetDemoLines(strip.render(demoContentWidth(width)), width),
      "",
      `  ${theme.fg("muted", `Active category: ${this.selected}`)}`,
      "",
      demoFooterRule(theme, width, [
        "Tab/Shift+Tab switch · Escape back",
        "Tab/Shift+Tab · Esc back",
        "Esc back",
      ]),
    ];
  }

  handleInput(data: string): void {
    if (!this._focused) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return;
    }
    const direction = matchesKey(data, Key.shift("tab")) ? -1 : matchesKey(data, Key.tab) ? 1 : 0;
    if (direction === 0) return;
    this.selected = nextTab(PROVIDER_TABS, this.selected, direction) ?? this.selected;
    this.options.tui.requestRender();
  }

  invalidate(): void {}
}

class CollapsibleDemo implements Component, Focusable {
  private readonly options: GalleryOptions;
  private readonly onClose: () => void;
  private readonly block: CollapsibleBlock;
  private _focused = true;

  constructor(options: GalleryOptions, onClose: () => void, onOpen: () => void) {
    this.options = options;
    this.onClose = onClose;
    this.block = new CollapsibleBlock({
      summary: "Captured tool output · 20 lines",
      preview: Array.from({ length: 20 }, (_, index) => `Preview row ${index + 1}`),
      previewLimit: 6,
      onOpenOverlay: onOpen,
      requestRender: () => options.tui.requestRender(),
    });
    this.block.focused = true;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.block.focused = value;
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    return [
      demoTitleRule(theme, "CollapsibleBlock", width),
      "",
      ...insetDemoLines(
        this.block.render(demoContentWidth(width)).map((line) => theme.fg("text", line)),
        width,
      ),
      "",
      demoFooterRule(theme, width, [
        "Enter/Space fold · o open overlay · Escape back",
        "Enter fold · o open · Esc back",
        "Esc back",
      ]),
    ];
  }

  handleInput(data: string): void {
    if (!this._focused) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return;
    }
    this.block.handleInput(data);
  }

  invalidate(): void {
    this.block.invalidate();
  }
}
