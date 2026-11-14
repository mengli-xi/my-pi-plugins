import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEditorChrome } from "../editor-chrome.ts";
import { clipboardImageMarkdownTransformer } from "../image-marker.ts";
import { installInternalsMonitor } from "../internals-report.ts";
import type { LifecycleManager } from "../lifecycle.ts";
import type { CcStyleObservability } from "../observability.ts";
import { ModelCapacityClient } from "../model-capacity-client.ts";
import installStatusLine from "../statusline/install.ts";
import { MAIN_INITIAL_LINES, MAIN_INITIAL_CONTRIBUTION_LINE } from "../statusline/initial-lines.ts";
import { installModelCapacityStatusConsumer } from "../statusline/model-capacity.ts";
import { installProcessesStatusConsumer } from "../statusline/processes.ts";
import type { StatuslineTranscriptCache } from "../statusline/transcript.ts";
import { installProviderTabbedModelSelector } from "../model-selector-tabs.ts";
import type { FullscreenLayoutConfig } from "../host/fullscreen/bridge.ts";
import { installFullscreenHost, type FullscreenHost } from "../host/fullscreen/install.ts";

export function installShellFeatures(
  pi: ExtensionAPI,
  lifecycle: LifecycleManager,
  observability: CcStyleObservability,
  statuslineTranscriptCache: StatuslineTranscriptCache,
  layout: () => FullscreenLayoutConfig,
): void {
  pi.registerMarkdownTransformer(clipboardImageMarkdownTransformer);
  let fullscreen: FullscreenHost | undefined;
  lifecycle.install({
    id: "fullscreen-host",
    install: () => {
      fullscreen = installFullscreenHost(pi, layout, { warmClipboard: true });
      return { dispose: () => { fullscreen?.dispose(); fullscreen = undefined; } };
    },
    health: () => fullscreen?.health() ?? { status: "inactive" as const },
  }, undefined);
  lifecycle.install({
    id: "editor-chrome",
    install: () => installEditorChrome(pi),
    health: () => ({ status: "ok" as const }),
  }, undefined);

  lifecycle.install({
    id: "statusline",
    install: () => installStatusLine(
      pi,
      (name, action) => observability.measure(name, action),
      { initialLines: MAIN_INITIAL_LINES, initialContributionLine: MAIN_INITIAL_CONTRIBUTION_LINE },
      statuslineTranscriptCache,
    ),
    health: () => ({ status: "ok" as const }),
  }, undefined);

  const modelCapacity = new ModelCapacityClient(pi.events);
  lifecycle.install({
    id: "model-capacity-client",
    install: () => ({ dispose: () => modelCapacity.dispose() }),
    health: () => ({ status: "ok" as const }),
  }, undefined);

  lifecycle.install({
    id: "processes-status-consumer",
    install: () => ({ dispose: installProcessesStatusConsumer(pi).dispose }),
    health: () => ({ status: "ok" as const }),
  }, undefined);

  lifecycle.install({
    id: "model-capacity-status-consumer",
    install: () => ({ dispose: installModelCapacityStatusConsumer(pi, modelCapacity).dispose }),
    health: () => ({ status: "ok" as const }),
  }, undefined);

  lifecycle.install({
    id: "model-selector-tabs",
    install: () => ({ dispose: installProviderTabbedModelSelector(modelCapacity) }),
    health: () => ({ status: "ok" as const }),
  }, undefined);

  lifecycle.install({
    id: "internals-monitor",
    install: () => {
      installInternalsMonitor(pi);
      return { dispose: () => {} };
    },
    health: () => ({ status: "ok" as const }),
  }, undefined);
}
