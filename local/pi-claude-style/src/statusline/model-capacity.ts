import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  showTextPanel,
  type TextPanel,
  type TextPanelContent,
} from "pi-li-uikit/text-panel";

import { STATUS_LINE_ROW_CHANNEL } from "../integration-contracts.ts";
import { readStatusLineConfig } from "./config.ts";
import type { ModelCapacityClient } from "../model-capacity-client.ts";
import {
  isCapacityProviderId,
  formatCapacityDetails,
  formatStatuslineCapacityColored,
  providerCapacity,
  type CapacityDetails,
  type CapacityProviderId,
} from "../model-capacity.ts";

export const STATUS_LINE_MODEL_CAPACITY_KEY = "model-capacity";
const WATCHER_ID = "cc-style:statusline";
export const CAPACITY_DETAILS_MAX_VISIBLE = 18;

function sessionId(ctx: ExtensionContext): string | undefined {
  const value = ctx.sessionManager.getSessionId();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function model(ctx: ExtensionContext): { provider?: CapacityProviderId; id?: string } {
  const provider = ctx.model?.provider;
  const id = ctx.model?.id;
  return {
    ...(isCapacityProviderId(provider)
      ? { provider }
      : {}),
    ...(typeof id === "string" && id.length > 0 ? { id } : {}),
  };
}

export interface InstalledModelCapacityStatusConsumer {
  dispose(): void;
}

export type CapacityDetailsUpdater = (details: CapacityDetails) => void;

export type CapacityDetailsOpener = (
  ctx: ExtensionContext,
  details: CapacityDetails,
  onOpen: (update: CapacityDetailsUpdater) => void,
) => void | Promise<void>;

export function renderCapacityDetailsBody(
  body: string,
  width: number,
  theme: Theme,
): string[] {
  const safeWidth = Math.max(1, width);
  return body.split("\n").flatMap((line) => {
    if (!line) return [""];
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return wrapTextWithAnsi(theme.fg("text", line), safeWidth);
    }
    const key = line.slice(0, separator + 1);
    const value = line.slice(separator + 1).trimStart();
    const painted = value
      ? `${theme.fg("muted", key)} ${theme.fg("text", value)}`
      : theme.fg("muted", key);
    return wrapTextWithAnsi(painted, safeWidth);
  });
}

export function capacityDetailsPanelContent(details: CapacityDetails): TextPanelContent {
  return {
    ...details,
    format: "plain",
    maxVisible: CAPACITY_DETAILS_MAX_VISIBLE,
    renderBody: (width, theme) => renderCapacityDetailsBody(details.body, width, theme),
  };
}

function updateCapacityPanel(panel: TextPanel, details: CapacityDetails): void {
  const content = capacityDetailsPanelContent(details);
  panel.update({
    heading: content.title,
    body: content.body,
    format: content.format,
    tone: content.tone,
    glyph: content.glyph,
    maxVisible: content.maxVisible,
    renderBody: content.renderBody,
  });
}

const openCapacityDetails: CapacityDetailsOpener = async (ctx, details, onOpen) => {
  let update: CapacityDetailsUpdater | undefined;
  await showTextPanel(ctx, capacityDetailsPanelContent(details), {
    onCreate: (panel) => {
      update = (next) => updateCapacityPanel(panel, next);
    },
    onFirstRender: () => {
      if (update) onOpen(update);
    },
  });
};

function withCapacityState(details: CapacityDetails, state: string): CapacityDetails {
  return {
    ...details,
    body: /^State:.*$/m.test(details.body)
      ? details.body.replace(/^State:.*$/m, `State: ${state}`)
      : `${details.body}\nState: ${state}`,
  };
}

export function installModelCapacityStatusConsumer(
  pi: ExtensionAPI,
  client: ModelCapacityClient,
  statuslineEnabled: (ctx: ExtensionContext) => boolean = (ctx) => Boolean(readStatusLineConfig(ctx.cwd)),
  openDetails: CapacityDetailsOpener = openCapacityDetails,
): InstalledModelCapacityStatusConsumer {
  let activeCtx: ExtensionContext | undefined;
  let activeSession: string | undefined;
  let watchedProvider: CapacityProviderId | undefined;
  let detailsOpen = false;
  let detailsGeneration = 0;

  const cancelDetails = (): void => {
    detailsGeneration++;
    detailsOpen = false;
  };

  const withdraw = (): void => {
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, { key: STATUS_LINE_MODEL_CAPACITY_KEY });
  };

  const publish = (): void => {
    const ctx = activeCtx;
    if (!ctx) return withdraw();
    const current = model(ctx);
    if (!current.provider || !current.id) return withdraw();
    const text = formatStatuslineCapacityColored(
      {
        fg(color, value) {
          const tone = color === "error" ? 95 : color === "warning" ? 101 : color === "success" ? 65 : 102;
          return `\x1b[38;5;${tone}m${value}\x1b[39m`;
        },
      },
      providerCapacity(client.current(), current.provider),
      current.id,
    );
    if (!text) return withdraw();
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, {
      key: STATUS_LINE_MODEL_CAPACITY_KEY,
      placement: "inline",
      row: 3,
      align: "left",
      line: text,
      onClick: () => {
        if (detailsOpen || activeCtx !== ctx) return false;
        const clicked = model(ctx);
        if (!clicked.provider || !clicked.id) return false;
        const clickedProvider = clicked.provider;
        const clickedModelId = clicked.id;
        const cached = formatCapacityDetails(
          providerCapacity(client.current(), clickedProvider),
          clickedModelId,
        );
        if (!cached) return false;
        const clickedSession = activeSession;
        detailsOpen = true;
        const detailsRequest = ++detailsGeneration;
        let updateDetails: CapacityDetailsUpdater | undefined;

        const refresh = (): void => {
          if (detailsGeneration !== detailsRequest || activeCtx !== ctx) return;
          void client.refresh(clickedProvider, clickedSession)
            .then((snapshot) => {
              const latest = model(ctx);
              if (detailsGeneration !== detailsRequest || activeCtx !== ctx || activeSession !== clickedSession
                || latest.provider !== clickedProvider || latest.id !== clickedModelId) return;
              const details = formatCapacityDetails(
                providerCapacity(snapshot, clickedProvider),
                clickedModelId,
              );
              if (!details) throw new Error("fresh capacity data is unavailable");
              updateDetails?.(details);
            })
            .catch((error: unknown) => {
              if (detailsGeneration !== detailsRequest || activeCtx !== ctx || activeSession !== clickedSession) return;
              updateDetails?.(withCapacityState(cached, "Refresh failed"));
              try {
                ctx.ui.notify(
                  `Unable to refresh model capacity: ${error instanceof Error ? error.message : String(error)}`,
                  "warning",
                );
              } catch {
                // The session may have been replaced while the refresh completed.
              }
            });
        };

        void Promise.resolve(openDetails(
          ctx,
          withCapacityState(cached, "Refreshing"),
          (update) => {
            if (detailsGeneration !== detailsRequest || activeCtx !== ctx) return;
            updateDetails = update;
            // The default opener invokes this only after the cached first frame.
            refresh();
          },
        )).catch((error: unknown) => {
          if (detailsGeneration !== detailsRequest || activeCtx !== ctx) return;
          try {
            ctx.ui.notify(
              `Unable to show model capacity: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          } catch {
            // The session may have been replaced while the panel opened.
          }
        }).finally(() => {
          if (detailsGeneration === detailsRequest) {
            detailsGeneration++;
            detailsOpen = false;
          }
        });
        return true;
      },
    });
  };

  const updateWatch = (ctx: ExtensionContext): void => {
    cancelDetails();
    const nextSession = sessionId(ctx);
    const enabled = ctx.hasUI && statuslineEnabled(ctx);
    const nextProvider = enabled ? model(ctx).provider : undefined;
    activeCtx = enabled ? ctx : undefined;
    if (activeSession !== nextSession) {
      if (watchedProvider) client.watch(WATCHER_ID, "release", activeSession, [watchedProvider]);
      watchedProvider = undefined;
      activeSession = nextSession;
      client.bindSession(nextSession);
    }
    if (watchedProvider !== nextProvider) {
      if (watchedProvider) client.watch(WATCHER_ID, "release", activeSession, [watchedProvider]);
      watchedProvider = nextProvider;
      if (watchedProvider) client.watch(WATCHER_ID, "acquire", activeSession, [watchedProvider]);
    }
    if (nextProvider) client.request(activeSession);
    publish();
  };

  const stopSnapshot = client.subscribe(() => publish());

  pi.on("session_start", (_event, ctx) => updateWatch(ctx));
  pi.on("model_select", (_event, ctx) => updateWatch(ctx));
  pi.on("session_shutdown", () => {
    if (watchedProvider) client.watch(WATCHER_ID, "release", activeSession, [watchedProvider]);
    activeCtx = undefined;
    activeSession = undefined;
    watchedProvider = undefined;
    cancelDetails();
    withdraw();
  });

  return {
    dispose() {
      stopSnapshot();
      if (watchedProvider) client.watch(WATCHER_ID, "release", activeSession, [watchedProvider]);
      activeCtx = undefined;
      activeSession = undefined;
      watchedProvider = undefined;
      cancelDetails();
      withdraw();
    },
  };
}
