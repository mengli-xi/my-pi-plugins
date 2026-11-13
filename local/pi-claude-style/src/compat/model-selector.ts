import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Component, Container, Text } from "@earendil-works/pi-tui";

export interface CompatModelLike {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

export interface CompatModelItem {
  readonly provider: string;
  readonly id: string;
  readonly model: CompatModelLike;
}

function modelDisplayName(model: CompatModelLike): string | undefined {
  const name = model.name?.trim();
  // Default provider + id names add no information beside the native id.
  return name && name !== model.id && !name.endsWith(model.id) ? name : undefined;
}

/** Public model metadata, read here alongside the selector's model items. */
export function modelSelectorCapabilities(item: CompatModelItem) {
  const model = item.model as CompatModelLike & Partial<Pick<Model<Api>, "contextWindow" | "input">>;
  return { contextWindow: model.contextWindow, supportsImages: model.input?.includes("image") ?? false, displayName: modelDisplayName(model) };
}

/** Pi 1.2 stores each native row in Text.text; the fields probe owns this seam. */
export function prepareModelSelectorRow(row: Component, item: CompatModelItem, hideProvider: boolean): (displayName?: string) => void {
  const host = row as Component & { text?: unknown; setText?: Text["setText"] };
  const text = host.text;
  const setText = host.setText;
  if (typeof text !== "string" || typeof setText !== "function") {
    throw new Error("model selector row text is unavailable");
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sgr = "(?:\\x1b\\[[0-9;]*m)*";
  // Pi 1.5 adds its own distinct-name label before the provider badge. Match
  // only this model's exact name, then let CC apply its existing width policy.
  const name = item.model.name?.trim();
  const nativeName = name ? `(?: ${sgr}\\(${escape(name)}\\)${sgr})?` : "";
  const nativeSlot = new RegExp(`^(${sgr}(?:→ |  )${sgr}(?:✓ |  )${sgr}${escape(item.id)}${sgr})${nativeName}( ${sgr}\\[${escape(item.provider)}\\])(${sgr}(?: · default${sgr})?)$`);
  const match = nativeSlot.exec(text);
  if (!match) throw new Error("model selector row provider slot is unavailable");
  return (displayName = "") => setText.call(row, match[1]! + displayName + (hideProvider ? "" : match[2]!) + match[3]!);
}

interface SelectorHost {
  children?: Component[];
  allModels?: CompatModelItem[];
  scopedModelItems?: CompatModelItem[];
  activeModels?: CompatModelItem[];
  filteredModels?: CompatModelItem[];
  selectedIndex?: number;
  currentModel?: CompatModelLike;
  scope?: "all" | "scoped";
  getSearchInput: ModelSelectorComponent["getSearchInput"];
  listContainer?: Container;
  scopeText?: { setText(text: string): void };
  scopeHintText?: { setText(text: string): void };
  errorMessage?: string;
  refreshStatusMessage?: string;
  refreshStatusSuccess?: boolean;
  closed?: boolean;
  tui?: { requestRender(): void };
  filterModels?: (query: string) => void;
  updateList?: () => void;
  setScope?: (scope: "all" | "scoped") => void;
}

export interface ModelSelectorCompat {
  readonly identity: object;
  readonly children: Component[] | undefined;
  readonly allModels: CompatModelItem[] | undefined;
  readonly scopedModelItems: CompatModelItem[] | undefined;
  activeModels: CompatModelItem[] | undefined;
  filteredModels: CompatModelItem[] | undefined;
  selectedIndex: number;
  readonly currentModel: CompatModelLike | undefined;
  readonly scope: "all" | "scoped" | undefined;
  readonly searchValue: string;
  readonly listChildren: Component[] | undefined;
  readonly errorMessage: string | undefined;
  readonly refreshStatusMessage: string | undefined;
  readonly refreshStatusSuccess: boolean;
  readonly closed: boolean;
  readonly hasLifecycleFields: boolean;
  clearScopeHints(): void;
  filter(query: string): boolean;
  updateList(): boolean;
  setScope(scope: "all" | "scoped"): boolean;
  requestRender(): boolean;
}

/** All Pi 1.2 selector instance fields are isolated behind this adapter. */
export function modelSelectorCompat(instance: unknown): ModelSelectorCompat {
  const host = instance as SelectorHost;
  return {
    identity: instance as object,
    get children() { return host.children; },
    get allModels() { return host.allModels; },
    get scopedModelItems() { return host.scopedModelItems; },
    get activeModels() { return host.activeModels; },
    set activeModels(value) { host.activeModels = value; },
    get filteredModels() { return host.filteredModels; },
    set filteredModels(value) { host.filteredModels = value; },
    get selectedIndex() { return host.selectedIndex ?? 0; },
    set selectedIndex(value) { host.selectedIndex = value; },
    get currentModel() { return host.currentModel; },
    get scope() { return host.scope; },
    get searchValue() { return host.getSearchInput().getValue(); },
    get listChildren() { return host.listContainer?.children; },
    get errorMessage() { return host.errorMessage; },
    get refreshStatusMessage() { return host.refreshStatusMessage; },
    get refreshStatusSuccess() { return host.refreshStatusSuccess === true; },
    get closed() { return host.closed === true; },
    get hasLifecycleFields() {
      return typeof host.closed === "boolean" && typeof host.tui?.requestRender === "function";
    },
    clearScopeHints() {
      host.scopeText?.setText("");
      host.scopeHintText?.setText("");
    },
    filter(query) {
      if (typeof host.filterModels !== "function") return false;
      host.filterModels.call(instance, query);
      return true;
    },
    updateList() {
      if (typeof host.updateList !== "function") return false;
      host.updateList.call(instance);
      return true;
    },
    setScope(scope) {
      if (typeof host.setScope !== "function") return false;
      host.setScope.call(instance, scope);
      return true;
    },
    requestRender() {
      if (typeof host.tui?.requestRender !== "function") return false;
      host.tui.requestRender();
      return true;
    },
  };
}

export function modelSelectorPrototype<T>(): T {
  return ModelSelectorComponent.prototype as unknown as T;
}
