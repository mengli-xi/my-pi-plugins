/**
 * Pi 1.5 compatibility contract for CC Style presentation patches.
 *
 * This is the single inventory of host surfaces CC Style touches. A member is
 * either public (exported in Pi's declarations, so TypeScript/build checks are
 * the compatibility gate) or private (must have a runtime probe and fail-open
 * fallback). Feature files still own the user-facing consequence and fallback;
 * this catalog owns the version classification so upgrades have one audit
 * starting point.
 */

export const PI_COMPAT_BASELINE = "1.5" as const;

export interface PiCompatSurface {
  id: string;
  owner: string;
  members: readonly string[];
  stability: "public" | "private";
  verification: "typescript" | "offline-probe" | "live-probe";
}

export const PI_1_5_SURFACES: readonly PiCompatSurface[] = [
  {
    id: "presentation-owner.renderer-boundaries",
    owner: "ExtensionRunner / Component and Focusable / ToolExecutionComponent",
    members: ["createContext", "getEntryRenderer", "getMessageRenderer", "resolveToolRenderers", "getMarkdownTransformers", "ExtensionAPI.registerMarkdownTransformer", "Component.render/invalidate/handleInput/handleMouse/wantsKeyRelease", "Focusable.focused", "TuiMouseEvent"],
    stability: "public",
    verification: "typescript",
  },
  {
    id: "user-message.timestampBinding",
    owner: "InteractiveMode",
    members: ["addMessageToChat", "chatContainer.children"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "editor-chrome.editor",
    owner: "ExtensionUIContext / EditorComponent / EditorFactory",
    members: ["getEditorComponent", "setEditorComponent", "render", "setPaddingX", "EditorFactory(tui).requestRender"],
    stability: "public",
    verification: "typescript",
  },
  {
    id: "editor-chrome.history",
    owner: "Editor instance",
    members: ["history", "historyIndex"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "editor-chrome.atomicImageMarker",
    owner: "Editor instance",
    members: ["segment"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "assistant-message.updateContent",
    owner: "AssistantMessageComponent",
    members: ["updateContent"],
    stability: "public",
    verification: "typescript",
  },
  {
    id: "user-message.render",
    owner: "UserMessageComponent",
    members: ["render", "handleMouse"],
    stability: "public",
    verification: "typescript",
  },
  {
    id: "user-message.text",
    owner: "UserMessageComponent instance",
    members: ["text"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "repeated-errors.notify",
    owner: "ExtensionRunner / ExtensionUIContext",
    members: ["setUIContext", "notify"],
    stability: "public",
    verification: "typescript",
  },
  {
    id: "repeated-errors.showError",
    owner: "InteractiveMode",
    members: ["showError"],
    stability: "public",
    verification: "typescript",
  },
  {
    id: "assistant-message.contentContainer",
    owner: "AssistantMessageComponent instance",
    members: ["contentContainer.children", "outputPad"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "assistant-message.childShape",
    owner: "MouseRegion / Markdown instance",
    members: ["MouseRegion.child", "Markdown.defaultTextStyle"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "assistant-message.lastMessage",
    owner: "AssistantMessageComponent instance",
    members: ["lastMessage"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "model-selector-tabs.methods",
    owner: "ModelSelectorComponent.prototype",
    members: ["filterModels", "updateList", "handleInput", "dispose", "setScope"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "model-selector-tabs.rowPresentation",
    owner: "Model / Text",
    members: ["Model.name", "Model.contextWindow", "Model.input", "Text.setText"],
    stability: "public",
    verification: "typescript",
  },
  {
    id: "model-selector-tabs.fields",
    owner: "ModelSelectorComponent instance",
    members: [
      "allModels",
      "scopedModelItems",
      "activeModels",
      "filteredModels",
      "selectedIndex",
      "searchInput",
      "listContainer",
      "listContainer.children[].text",
      "refreshStatusMessage",
      "refreshStatusSuccess",
      "children",
      "closed",
      "tui.requestRender",
    ],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "session-info.handleSessionCommand",
    owner: "InteractiveMode.prototype",
    members: ["handleSessionCommand"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "session-info.capture",
    owner: "InteractiveMode instance",
    members: ["chatContainer"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "fullscreen.selectionColors",
    owner: "TuiAltScreen.prototype",
    members: ["applySelectionHighlight"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "fullscreen.stickySelection",
    owner: "TuiAltScreen.prototype",
    members: ["applySelection"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "fullscreen.editorGeometry",
    owner: "TuiAltScreen / pi-tui dist/layout.js",
    members: ["currentLayout", "layoutRoot", "renderLayoutFrame"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "fullscreen.outsideClick",
    owner: "TuiAltScreen",
    members: ["dispatchMouseToOverlay", "focusedComponent", "isOverlayFocused"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "fullscreen.frame",
    owner: "TuiAltScreen.prototype",
    members: ["compositeScrollToEndIndicator"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "fullscreen.autocomplete",
    owner: "Editor",
    members: ["autocompleteState", "autocompleteList", "render appended menu shape"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "fullscreen.sticky",
    owner: "TuiAltScreen / ScrollView / UserMessageComponent",
    members: ["currentLayout.primaryScrollView", "layoutRoot", "ScrollView.children", "UserMessageComponent.text", "LayoutBox.scrollContentLines"],
    stability: "private",
    verification: "live-probe",
  },
  {
    id: "shell.widgetSpacing",
    owner: "InteractiveMode.prototype",
    members: ["renderWidgetContainer"],
    stability: "private",
    verification: "offline-probe",
  },
  {
    id: "working.retryEvents", owner: "InteractiveMode.prototype",
    members: ["handleEvent(auto_retry_start/auto_retry_end/agent_start)"],
    stability: "private", verification: "offline-probe",
  },
  {
    id: "working.retryIndicator", owner: "InteractiveMode.prototype",
    members: ["showStatusIndicator(StatusIndicator)"],
    stability: "private", verification: "offline-probe",
  },
  {
    id: "working.retrySession", owner: "AgentSession.prototype",
    members: ["bindExtensions (prototype wrapper; public subscribe/sessionManager)"],
    stability: "private", verification: "offline-probe",
  },
  {
    id: "working.retryView", owner: "InteractiveMode.prototype",
    members: ["init (prototype wrapper)"],
    stability: "private", verification: "offline-probe",
  },
  {
    id: "history.renderEntries", owner: "InteractiveMode",
    members: ["renderSessionEntries", "renderSessionItems(items, messageMeta, options) dispatch", "session", "sessionManager", "renderer", "AgentSession.extensionRunner (public)", "handleEvent synchronous compaction clear/render (existing seam)", "chatContainer/addMessageToChat (existing seam)"],
    stability: "private", verification: "offline-probe",
  },
  {
    id: "history.selectionAnchors", owner: "TuiAltScreen",
    members: ["selectionAnchor", "selectionFocus", "selectionInitialRange", "lastClick"],
    stability: "private", verification: "offline-probe",
  },
] as const;

export function privatePiSurfaces(): readonly PiCompatSurface[] {
  return PI_1_5_SURFACES.filter((surface) => surface.stability === "private");
}

export function publicPiSurfaces(): readonly PiCompatSurface[] {
  return PI_1_5_SURFACES.filter((surface) => surface.stability === "public");
}
