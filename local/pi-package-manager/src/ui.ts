import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { InformationPanel } from "pi-li-uikit/information-panel";
import { printablePanelInput } from "pi-li-uikit/editor-panel";

import type {
  ManagedPackage,
  ManagerAction,
  PackageViewState,
} from "./types.js";

const FILTERS: PackageViewState["filter"][] = ["all", "enabled", "disabled", "updates"];

function scopeLabel(pkg: ManagedPackage): string {
  const scopes = new Set(pkg.entries.map((entry) => entry.scope));
  return [scopes.has("global") ? "G" : "", scopes.has("project") ? "P" : ""]
    .filter(Boolean)
    .join("+");
}

function matchesSearch(pkg: ManagedPackage, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    pkg.displayName,
    pkg.source,
    pkg.manifest.description ?? "",
    pkg.manifest.version ?? "",
    pkg.installedPath ?? "",
  ].join("\n").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function filterPackages(
  packages: readonly ManagedPackage[],
  state: Pick<PackageViewState, "filter" | "query">,
  updates: ReadonlySet<string>,
): ManagedPackage[] {
  return packages.filter((pkg) => {
    if (!matchesSearch(pkg, state.query)) return false;
    if (state.filter === "enabled" && !pkg.enabled) return false;
    if (state.filter === "disabled" && pkg.enabled) return false;
    if (state.filter === "updates" && !updates.has(pkg.id)) return false;
    return true;
  });
}

function resourceSummary(pkg: ManagedPackage): string | undefined {
  const parts = Object.entries(pkg.manifest.resourceCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function filterSummary(pkg: ManagedPackage): string | undefined {
  const parts: string[] = [];
  for (const entry of pkg.entries) {
    const raw = entry.raw;
    if (typeof raw === "string") continue;
    const resources = (["extensions", "skills", "prompts", "themes"] as const)
      .flatMap((key) => {
        const values = raw[key];
        return Array.isArray(values) ? [`${key}:${values.length}`] : [];
      })
      .join(", ");
    if (raw.autoload === false || resources) {
      parts.push(`${entry.scope}: ${raw.autoload === false ? "autoload off" : "filtered"}${resources ? ` (${resources})` : ""}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export class PackageManagerView implements Focusable {
  readonly wantsMouse = true;
  private readonly panel: InformationPanel;
  private readonly listRows = new Map<number, number>();
  private readonly search = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly packages: readonly ManagedPackage[];
  private readonly updates: ReadonlySet<string>;
  private readonly updatesChecked: boolean;
  private readonly reloadRequired: boolean;
  private readonly onAction: (action: ManagerAction) => void;
  private filtered: ManagedPackage[] = [];
  private selectedIndex = 0;
  private detailOffset = 0;
  private detailStartRow = Number.POSITIVE_INFINITY;
  private detailOverflow = 0;
  private searchActive = false;
  private _focused = false;
  private state: PackageViewState;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    packages: readonly ManagedPackage[],
    updates: ReadonlySet<string>,
    updatesChecked: boolean,
    reloadRequired: boolean,
    initialState: PackageViewState | undefined,
    onAction: (action: ManagerAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.packages = packages;
    this.updates = updates;
    this.updatesChecked = updatesChecked;
    this.reloadRequired = reloadRequired;
    this.onAction = onAction;
    this.state = initialState ?? { filter: "all", query: "" };
    this.search.setValue(this.state.query);
    this.refresh(this.state.selectedId);
    this.panel = new InformationPanel({
      tui, theme,
      getView: () => ({
        title: "Plugins",
        fillsBody: true,
        renderBody: (width, bodyRows) => this.renderBody(width, bodyRows),
        footerHints: [
          "↑↓ move · / search · Tab filter · Space toggle · U check · u update · r reload · Esc close",
          "↑↓ · / search · Tab filter · Space toggle · U check · u update · r reload · Esc close",
          "↑↓ · / · Tab · Space · U/u · r · Esc close",
          "↑↓ · / · Tab · Space · Esc",
          "Esc close",
        ],
      }),
      onClose: () => this.onAction({ type: "close" }),
      onInput: (data) => { this.handleManagerInput(data); return true; },
      onMouse: (event, controller) => {
        if (event.kind === "wheel") {
          const point = controller.bodyPointAt(event.row, event.col);
          if (point && point.row >= this.detailStartRow) {
            this.detailOffset = Math.max(0, Math.min(this.detailOverflow, this.detailOffset + event.wheel * 3));
          } else this.move(event.wheel * 3);
        }
        else if (event.kind === "press" && event.button === 0) {
          const point = controller.bodyPointAt(event.row, event.col);
          const index = point ? this.listRows.get(point.row) : undefined;
          if (index !== undefined && index !== this.selectedIndex) {
            this.selectedIndex = index;
            this.detailOffset = 0;
          }
        }
        controller.requestRender();
        return true;
      },
    });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && this.searchActive;
    this.panel.focused = value;
  }

  getViewState(): PackageViewState {
    return {
      filter: this.state.filter,
      query: this.search.getValue().trim(),
      selectedId: this.selected()?.id,
    };
  }

  invalidate(): void {
    this.search.invalidate();
  }

  private selected(): ManagedPackage | undefined {
    return this.filtered[this.selectedIndex];
  }

  private refresh(preferredId?: string): void {
    const previous = preferredId ?? this.selected()?.id;
    this.state.query = this.search.getValue().trim();
    this.filtered = filterPackages(this.packages, this.state, this.updates);
    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    const nextIndex = previous ? this.filtered.findIndex((pkg) => pkg.id === previous) : -1;
    this.selectedIndex = nextIndex >= 0
      ? nextIndex
      : Math.min(this.selectedIndex, this.filtered.length - 1);
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) return;
    const nextIndex = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
    if (nextIndex !== this.selectedIndex) this.detailOffset = 0;
    this.selectedIndex = nextIndex;
  }

  private cycleFilter(delta: number): void {
    const index = FILTERS.indexOf(this.state.filter);
    this.state.filter = FILTERS[(index + delta + FILTERS.length) % FILTERS.length]!;
    this.detailOffset = 0;
    this.refresh();
  }

  setScreenOrigin(row: number, column: number): void { this.panel.setScreenOrigin(row, column); }
  setAvailableHeight(rows: number): void { this.panel.setAvailableHeight(rows); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.panel.handleMouse(event); }
  handleInput(data: string): void { this.panel.handleInput(data); }
  dispose(): void { this.panel.dispose(); }

  private handleManagerInput(data: string): void {
    if (this.searchActive) {
      if (matchesKey(data, Key.enter)) {
        this.searchActive = false;
        this.search.focused = false;
      } else if (matchesKey(data, Key.escape)) {
        this.search.setValue("");
        this.searchActive = false;
        this.search.focused = false;
        this.refresh();
      } else {
        const editing = [Key.backspace, Key.delete, Key.left, Key.right, Key.home, Key.end,
          Key.ctrl("a"), Key.ctrl("e"), Key.ctrl("k"), Key.ctrl("u"), Key.ctrl("w")]
          .some((key) => matchesKey(data, key));
        const input = editing ? data : printablePanelInput(data);
        if (input) this.search.handleInput(input);
        this.refresh();
      }
      this.tui.requestRender();
      return;
    }

    if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
      this.searchActive = true;
      this.search.focused = this._focused;
    } else if (matchesKey(data, Key.shift("tab"))) {
      this.cycleFilter(-1);
    } else if (matchesKey(data, Key.tab)) {
      this.cycleFilter(1);
    } else if (this.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.move(1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.move(-8);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.move(8);
    } else if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
    } else if (matchesKey(data, Key.end)) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    } else if (matchesKey(data, Key.space) || data === " ") {
      const selected = this.selected();
      if (selected) this.onAction({ type: "toggle", packageId: selected.id });
    } else if (data === "U") {
      this.onAction({ type: "check" });
    } else if (data === "u") {
      const selected = this.selected();
      if (selected) this.onAction({ type: "update", packageId: selected.id });
    } else if (data === "r" || data === "R") {
      this.onAction({ type: "reload" });
    } else if (matchesKey(data, Key.escape) && this.search.getValue()) {
      this.search.setValue("");
      this.refresh();
    } else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.onAction({ type: "close" });
    }
    this.tui.requestRender();
  }

  private filterLine(): string {
    const labels: Record<PackageViewState["filter"], string> = {
      all: "All",
      enabled: "Enabled",
      disabled: "Disabled",
      updates: "Updates",
    };
    return FILTERS.map((filter) => {
      const text = labels[filter];
      return filter === this.state.filter
        ? this.theme.fg("accent", `[${text}]`)
        : this.theme.fg("muted", text);
    }).join("  ");
  }

  private renderPackage(pkg: ManagedPackage, selected: boolean, width: number): string {
    const pointer = selected ? this.theme.fg("accent", "›") : " ";
    const status = pkg.missing
      ? this.theme.fg("warning", "!")
      : pkg.enabled
        ? this.theme.fg("success", "●")
        : this.theme.fg("dim", "○");
    const name = selected ? this.theme.bold(pkg.displayName) : pkg.displayName;
    const version = pkg.manifest.version ? this.theme.fg("dim", ` @${pkg.manifest.version}`) : "";
    const update = this.updates.has(pkg.id) ? this.theme.fg("warning", "  update") : "";
    const protectedLabel = pkg.protected ? this.theme.fg("muted", "  manager") : "";
    const line = `${pointer} ${status} [${scopeLabel(pkg)}] ${name}${version}${update}${protectedLabel}`;
    return truncateToWidth(line, width, "");
  }

  private detailLines(pkg: ManagedPackage, width: number): string[] {
    const details: Array<[string, string | undefined]> = [
      ["Description", pkg.manifest.description],
      ["Source", pkg.source],
      ["Scope", pkg.entries.map((entry) => `${entry.scope}:${entry.enabled ? "on" : "off"}`).join(" · ")],
      ["Path", pkg.installedPath ?? "not installed"],
      ["Package", [pkg.kind, pkg.manifest.version, pkg.manifest.license].filter(Boolean).join(" · ")],
      ["Resources", resourceSummary(pkg)],
      ["Filters", filterSummary(pkg)],
      ["Repository", pkg.manifest.repository ?? pkg.manifest.homepage],
      ["Note", pkg.protected ? "This manager cannot disable itself" : undefined],
    ];

    const lines: string[] = [];
    const innerWidth = Math.max(8, width - 4);
    for (const [label, value] of details) {
      if (!value || lines.length >= 10) continue;
      const content = `${this.theme.fg("muted", `${label}:`)} ${this.theme.fg("text", value)}`;
      for (const wrapped of wrapTextWithAnsi(content, innerWidth).slice(0, 2)) {
        lines.push(truncateToWidth(`  ${wrapped}`, width, ""));
        if (lines.length >= 10) break;
      }
    }
    return lines;
  }

  /**
   * Reserve the largest list/detail shape the current catalogue can render.
   * Filters and selection only replace rows inside these viewports, so the
   * editor slot never moves while the user searches or inspects packages.
   */
  private fixedGeometry(width: number, bodyRows: number): {
    maxVisible: number;
    listRows: number;
    paginationRows: number;
    detailRows: number;
  } {
    const maxVisible = Math.max(1, Math.min(12, Math.floor((bodyRows - 7) / 2)));
    const listRows = Math.max(1, Math.min(maxVisible, this.packages.length));
    const paginationRows = this.packages.length > maxVisible ? 1 : 0;
    return {
      maxVisible,
      listRows,
      paginationRows,
      detailRows: Math.min(Math.max(0, bodyRows - 6 - listRows - paginationRows), this.packages.reduce(
        (largest, pkg) => Math.max(largest, this.detailLines(pkg, width).length), 0,
      )),
    };
  }

  render(width: number): string[] { return this.panel.render(width); }

  private renderBody(width: number, bodyRows: number): string[] {
    this.listRows.clear();
    this.detailStartRow = Number.POSITIVE_INFINITY;
    const safeWidth = Math.max(1, width);
    const geometry = this.fixedGeometry(safeWidth, bodyRows);
    const lines: string[] = [];
    const enabled = this.packages.filter((pkg) => pkg.enabled).length;
    const updateCount = this.updates.size;
    const status = [
      `${this.packages.length} packages`,
      `${enabled} enabled`,
      this.updatesChecked ? `${updateCount} updates` : "updates unchecked",
      this.reloadRequired ? this.theme.fg("warning", "reload required") : undefined,
    ].filter(Boolean).join(" · ");

    lines.push(truncateToWidth(`  ${this.theme.fg("muted", status)}`, safeWidth, ""));
    lines.push("");

    if (this.searchActive) {
      const inputWidth = Math.max(1, safeWidth - 12);
      const input = this.search.render(inputWidth)[0] ?? "";
      lines.push(truncateToWidth(`  Search: ${input}`, safeWidth, ""));
    } else {
      const query = this.search.getValue().trim();
      lines.push(truncateToWidth(`  ${this.filterLine()}${query ? `  ${this.theme.fg("accent", `/${query}`)}` : ""}`, safeWidth, ""));
    }
    lines.push("");

    const half = Math.floor(geometry.maxVisible / 2);
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - half, this.filtered.length - geometry.maxVisible),
    );
    const end = Math.min(this.filtered.length, start + geometry.maxVisible);
    let renderedListRows = 0;
    if (this.filtered.length === 0) {
      lines.push(`  ${this.theme.fg("warning", "No matching packages")}`);
      renderedListRows = 1;
    } else {
      for (let index = start; index < end; index += 1) {
        const pkg = this.filtered[index]!;
        this.listRows.set(lines.length, index);
        lines.push(this.renderPackage(pkg, index === this.selectedIndex, safeWidth));
        renderedListRows += 1;
      }
    }
    for (let row = renderedListRows; row < geometry.listRows; row += 1) lines.push("");
    if (geometry.paginationRows > 0) {
      lines.push(this.filtered.length > geometry.maxVisible
        ? this.theme.fg("dim", `  ${start + 1}-${end} of ${this.filtered.length}`)
        : "");
    }

    const selected = this.selected();
    if (selected) {
      lines.push("");
      const allDetails = this.detailLines(selected, safeWidth);
      this.detailOverflow = Math.max(0, allDetails.length - geometry.detailRows);
      this.detailOffset = Math.min(this.detailOffset, this.detailOverflow);
      const position = this.detailOverflow > 0
        ? ` ${this.detailOffset + 1}-${Math.min(allDetails.length, this.detailOffset + geometry.detailRows)}/${allDetails.length} · wheel scroll`
        : "";
      lines.push(truncateToWidth(`  ${this.theme.fg("accent", this.theme.bold("Package info"))}${this.theme.fg("muted", position)}`, safeWidth, ""));
      this.detailStartRow = lines.length - 1;
      const details = allDetails.slice(this.detailOffset, this.detailOffset + geometry.detailRows);
      lines.push(...details);
      for (let row = details.length; row < geometry.detailRows; row += 1) lines.push("");
    } else if (this.packages.length > 0) {
      // Match the blank separator, title, and largest detail body without
      // showing stale information for an empty filter/search result.
      for (let row = 0; row < geometry.detailRows + 2; row += 1) lines.push("");
    }

    return lines;
  }
}
