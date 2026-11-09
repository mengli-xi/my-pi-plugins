import {
  convertToPng,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { withoutCodeFenceMarkers } from "../../code-fence.ts";
import { formatDuration } from "../../format.ts";
import { formatWebHeader } from "../../web-format.ts";
import { displayEditPath } from "../../edit-path.ts";
import type { ActivityPhaseSnapshot } from "../../activity-timeline.ts";
import type { TextOpenOptions } from "../../openers.ts";
import {
  formatImageBytes,
  imagePanelHeading,
  type ToolImagePreview,
} from "../../image-preview.ts";
import type { OverlayConfig, ToolActivity, ToolGroupSnapshot } from "../../types.ts";
import type { DiffColors } from "../../diff-colors.ts";
import type { CcStyleObservability } from "../../observability.ts";
import { createToolGroupOverlayClass } from "../../overlay.ts";
import {
  loadRuntimeModuleOnFirstUse,
  type RuntimeScope,
} from "../../runtime-scope.ts";

type OverlayUiModule = typeof import("pi-li-uikit/text-panel");
type ImagePanelUiModule = typeof import("pi-li-uikit/image-panel");
type SelectableOverlayUiModule = typeof import("pi-li-uikit/selectable-collapsible-panel");

export interface ActivityOverlaySource {
  phase: ActivityPhaseSnapshot;
  resolveActivity(toolCallId: string): ToolActivity | undefined;
  resolveNestedActivities?(toolCallId: string): readonly ToolActivity[];
  subscribe(
    listener: (snapshot: ActivityPhaseSnapshot | undefined) => void,
  ): () => void;
  /** Drop ``` marker rows from expanded thinking, as the transcript does. */
  hideCodeFenceMarkers?: boolean;
}

/**
 * Pi's custom UI API permits another floating view to stack above the first
 * while its `ui.custom()` promise is still pending. A double click can
 * therefore mount two views before either click sees the other's focus change.
 *
 * The UI, rather than the extension context, owns the modal stack. Key the
 * single-flight guard by `ctx.ui` so a session/context replacement cannot open
 * a second transcript overlay against the same TUI.
 */
export class TranscriptOverlayActions {
  private activeOverlayUis = new WeakSet<object>();
  private readonly runtime: RuntimeScope | undefined;
  private readonly observability: CcStyleObservability | undefined;
  private readonly convertImage: typeof convertToPng;
  private toolOverlayClass: ReturnType<typeof createToolGroupOverlayClass> | undefined;

  constructor(
    runtime?: RuntimeScope,
    observability?: CcStyleObservability,
    convertImage: typeof convertToPng = convertToPng,
  ) {
    this.runtime = runtime;
    this.observability = observability;
    this.convertImage = convertImage;
  }

  private loadOverlayUi(): Promise<OverlayUiModule | undefined> {
    if (!this.runtime) return import("pi-li-uikit/text-panel");
    return loadRuntimeModuleOnFirstUse(
      this.runtime,
      "shared-text-panel-ui",
      () => import("pi-li-uikit/text-panel"),
      this.observability,
    );
  }

  private loadImagePanelUi(): Promise<ImagePanelUiModule | undefined> {
    if (!this.runtime) return import("pi-li-uikit/image-panel");
    return loadRuntimeModuleOnFirstUse(
      this.runtime,
      "shared-image-panel-ui",
      () => import("pi-li-uikit/image-panel"),
      this.observability,
    );
  }

  private loadSelectableOverlayUi(): Promise<SelectableOverlayUiModule | undefined> {
    if (!this.runtime) return import("pi-li-uikit/selectable-collapsible-panel");
    return loadRuntimeModuleOnFirstUse(
      this.runtime,
      "shared-selectable-collapsible-panel-ui",
      () => import("pi-li-uikit/selectable-collapsible-panel"),
      this.observability,
    );
  }

  private async withLoadingStatus<T>(
    ctx: ExtensionContext,
    action: () => Promise<T>,
  ): Promise<T> {
    let shown = false;
    const timer = setTimeout(() => {
      try {
        ctx.ui.setStatus("cc-style:lazy-overlay", "Loading transcript view…");
        shown = true;
      } catch {
        shown = false;
      }
    }, 50);
    try {
      return await action();
    } finally {
      clearTimeout(timer);
      if (shown) {
        try { ctx.ui.setStatus("cc-style:lazy-overlay", undefined); } catch { /* stale UI */ }
      }
    }
  }

  /** Warm both transcript-view implementations during an explicitly configured idle slot. */
  async preload(): Promise<void> {
    await Promise.all([this.loadOverlayUi(), this.loadSelectableOverlayUi()]);
  }

  private claimOverlay(ctx: ExtensionContext): (() => void) | undefined {
    const ui = ctx.ui as object;
    if (this.activeOverlayUis.has(ui)) return undefined;
    this.activeOverlayUis.add(ui);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOverlayUis.delete(ui);
    };
  }

  /** Drop runtime-owned UI identities without retaining a process-global guard. */
  dispose(): void {
    this.activeOverlayUis = new WeakSet<object>();
    this.toolOverlayClass = undefined;
  }

  async openGroup(
    ctx: ExtensionContext,
    group: ToolGroupSnapshot,
    maxResultChars: number,
    overlayConfig: OverlayConfig,
    diffColors: DiffColors,
    formatActivity: (activity: ToolGroupSnapshot["activities"][number]) => string,
    subscribe?: (
      listener: (snapshot: ToolGroupSnapshot | undefined) => void,
    ) => () => void,
    activity?: ActivityOverlaySource,
  ): Promise<void> {
    if (!ctx.hasUI) return;
    const release = this.claimOverlay(ctx);
    if (!release) return;
    let unsubscribe = () => {};
    try {
      const [module, selectableModule] = await this.withLoadingStatus(
        ctx,
        () => Promise.all([this.loadOverlayUi(), this.loadSelectableOverlayUi()]),
      );
      if (!module || !selectableModule) return;
      const ToolGroupOverlay = this.toolOverlayClass ??=
        createToolGroupOverlayClass(selectableModule.SelectableCollapsiblePanel);
      await module.showTextPanelComponent(ctx, (host) => {
        const panel = new ToolGroupOverlay({
          ...host,
          ...(activity
            ? {
              phase: activity.phase,
              resolveActivity: activity.resolveActivity,
              resolveNestedActivities: activity.resolveNestedActivities,
              hideCodeFenceMarkers: activity.hideCodeFenceMarkers,
            }
            : { group }),
          maxResultChars,
          diffColors,
          formatActivity,
          now: Date.now,
          overlay: overlayConfig,
          cwd: ctx.cwd,
        });
        if (activity) {
          let latestPhase = activity.phase;
          const documentReleases = new Map<string, () => void>();
          const syncDocuments = (snapshot: ActivityPhaseSnapshot): void => {
            const activeIds = new Set(
              snapshot.items
                .filter((item) => item.kind === "thinking")
                .map((item) => item.id),
            );
            for (const [id, dispose] of documentReleases) {
              if (activeIds.has(id)) continue;
              dispose();
              documentReleases.delete(id);
            }
            for (const item of snapshot.items) {
              if (item.kind !== "thinking" || documentReleases.has(item.id)) continue;
              documentReleases.set(
                item.id,
                item.document.subscribePanel(() => panel.updatePhase(latestPhase)),
              );
            }
          };
          unsubscribe = activity.subscribe((snapshot) => {
            if (!snapshot) {
              panel.dismiss();
              return;
            }
            latestPhase = snapshot;
            panel.updatePhase(snapshot);
            syncDocuments(snapshot);
          });
          const releaseActivity = unsubscribe;
          unsubscribe = () => {
            releaseActivity();
            for (const dispose of documentReleases.values()) dispose();
            documentReleases.clear();
          };
        } else if (subscribe) {
          unsubscribe = subscribe((snapshot) => {
            if (!snapshot) {
              panel.dismiss();
              return;
            }
            panel.updateGroup(snapshot);
          });
        }
        return panel;
      });
    } catch (error) {
      ctx.ui.notify(
        `Unable to open ${activity ? "activity" : "tool"} transcript: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    } finally {
      unsubscribe();
      release();
    }
  }

  async openImages(
    ctx: ExtensionContext,
    sourceImages: readonly ToolImagePreview[],
  ): Promise<void> {
    if (!ctx.hasUI || sourceImages.length === 0) return;
    const generation = this.runtime?.generation;
    const stillCurrent = (): boolean =>
      !this.runtime || (generation !== undefined && this.runtime.accepts(generation));
    if (!stillCurrent()) return;
    const release = this.claimOverlay(ctx);
    if (!release) return;
    try {
      const module = await this.withLoadingStatus(ctx, () => this.loadImagePanelUi());
      if (!module || !stillCurrent()) return;
      const capabilities = getCapabilities();
      const cellDimensions = getCellDimensions();
      const needsPng = capabilities.images === "kitty";
      const images = await Promise.all(sourceImages.map(async (image) => {
        if (!needsPng || image.mimeType === "image/png") {
          return { source: image, display: image };
        }
        const converted = await this.convertImage(image.data, image.mimeType);
        return { source: image, display: converted ? { ...image, ...converted } : undefined };
      }));
      if (!stillCurrent()) return;
      await module.showImagePanel(ctx, {
        title: imagePanelHeading(sourceImages),
        capabilities,
        cellDimensions,
        items: images.map(({ source, display }) => ({
          data: display?.data,
          mimeType: display?.mimeType,
          label: `${source.path ?? source.mimeType} (${formatImageBytes(source.sizeBytes)})`,
          path: source.path,
          unavailableReason: "Image preview unavailable: PNG conversion failed",
        })),
      });
    } catch (error) {
      if (stillCurrent()) {
        ctx.ui.notify(
          `Unable to open image preview: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
      }
    } finally {
      release();
    }
  }

  async openText(
    ctx: ExtensionContext,
    heading: string,
    body: string,
    overlayConfig: OverlayConfig,
    options?: TextOpenOptions,
  ): Promise<void> {
    const { onClose, hideCodeFenceMarkers, ...panelOptions } = options ?? {};
    if (!ctx.hasUI) {
      onClose?.();
      return;
    }
    const release = this.claimOverlay(ctx);
    if (!release) {
      onClose?.();
      return;
    }
    let unsubscribe = () => {};
    try {
      const module = await this.withLoadingStatus(ctx, () => this.loadOverlayUi());
      if (!module) return;
      await module.showTextPanelComponent(ctx, (host) => {
        const live = options?.live;
        const initial = live?.panelSnapshot?.();
        const initialBody = initial?.body ?? live?.snapshot() ?? body;
        // The panel's own Markdown path keeps fences; CC's thinking hides
        // them, drawing each body the panel is given the same way.
        const hideFences = hideCodeFenceMarkers && options?.format !== "plain" && !options?.renderBody;
        const renderBodyOf = (text: string) => hideFences
          ? (width: number, theme: Theme) => withoutCodeFenceMarkers(
            module.renderPanelMarkdown(text, width, theme, options?.tone ?? "text") ?? [],
          )
          : options?.renderBody;
        const panel = new module.TextPanel({
          ...host,
          heading,
          body: initialBody,
          note: initial?.note,
          ...panelOptions,
          renderBody: renderBodyOf(initialBody),
          onClose: host.onClose,
          overlay: overlayConfig,
        });
        const update = (nextBody: string, note?: string) => panel.update({
          heading,
          body: nextBody,
          note,
          format: options?.format,
          glyph: options?.glyph,
          tone: options?.tone,
          renderBody: renderBodyOf(nextBody),
        });
        if (live?.subscribePanel) {
          unsubscribe = live.subscribePanel((snapshot) => update(snapshot.body, snapshot.note));
        } else if (live) {
          unsubscribe = live.subscribe((nextBody) => update(nextBody));
        }
        return panel;
      });
    } catch (error) {
      ctx.ui.notify(
        `Unable to open ${heading}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    } finally {
      unsubscribe();
      release();
      onClose?.();
    }
  }
}

export function groupLabel(group: ToolGroupSnapshot, index: number, cwd?: string): string {
  const first = group.activities[0];
  if (group.presentation === "web-search" || group.presentation === "web-fetch") {
    return `${index + 1}. ${formatWebHeader(
      group.presentation,
      first?.args,
    )} · ${formatDuration(group.updatedAt - group.createdAt)}`;
  }
  if (group.presentation === "single-file-edit") {
    const args = typeof first?.args === "object" && first.args !== null
      ? first.args as Record<string, unknown>
      : {};
    const path = typeof args.path === "string"
      ? displayEditPath(args.path, cwd) || "file"
      : "file";
    return `${index + 1}. Edit(${path}) · ${formatDuration(
      group.updatedAt - group.createdAt,
    )}`;
  }
  const unique = [...new Set(group.activities.map((activity) => activity.toolName))];
  const tools = unique.slice(0, 3).join(", ");
  const extra = unique.length > 3 ? ` +${unique.length - 3}` : "";
  return `${index + 1}. ${tools}${extra} · ${group.activities.length} call${
    group.activities.length === 1 ? "" : "s"
  } · ${formatDuration(group.updatedAt - group.createdAt)}`;
}
