import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { preloadCcStyleCommandUi, registerCcStyleCommand } from "../commands/cc-style.ts";
import type { LoadingConfig } from "../config/defaults.ts";
import { ConfigService } from "../config/service.ts";
import { LifecycleManager } from "../lifecycle.ts";
import { CcStyleObservability } from "../observability.ts";
import type { RuntimeScope } from "../runtime-scope.ts";
import { UiScheduler } from "../ui-scheduler.ts";
import {
  ensureClaudeTranscriptAdapter,
  StatuslineTranscriptCache,
} from "../statusline/transcript.ts";

export interface CcStyleServices {
  configService?: ConfigService;
  observability: CcStyleObservability;
  lifecycle: LifecycleManager;
  scheduler: UiScheduler;
  statuslineTranscriptCache: StatuslineTranscriptCache;
}

/** Construct the control plane without installing renderer features. */
export function createServices(
  pi: ExtensionAPI,
  runtime?: RuntimeScope,
): CcStyleServices {
  const lifecycle = runtime?.lifecycle ?? new LifecycleManager();
  const configServiceEnabled = !["0", "false", "off"].includes(
    (process.env.PI_CC_STYLE_CONFIG_SERVICE ?? "1").toLowerCase(),
  );
  const configService = configServiceEnabled ? new ConfigService() : undefined;
  const observability = new CcStyleObservability();
  const scheduler = new UiScheduler(observability);
  const statuslineTranscriptCache = new StatuslineTranscriptCache();
  const installObservability = () => lifecycle.install({
    id: "observability",
    install: () => ({ dispose: () => observability.dispose() }),
    health: () => ({ status: "ok" as const }),
  }, undefined);

  installObservability();
  lifecycle.install({
    id: "ui-scheduler",
    install: () => ({ dispose: () => scheduler.dispose() }),
    health: () => ({ status: "ok" as const }),
  }, undefined);
  if (configService) {
    observability.configure(configService.active.performance);
    registerCcStyleCommand(
      pi,
      configService,
      observability,
      lifecycle,
      runtime,
      scheduler,
      async (ctx) => (await ensureClaudeTranscriptAdapter(
        ctx,
        statuslineTranscriptCache,
      )).analysis.cacheHistory,
    );
    const loading = configService.active.loading;
    if (runtime && shouldPreloadDiagnostics(loading)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const schedule = () => {
        if (started || timer || runtime.isDisposed) return;
        timer = scheduler.setTimer(() => {
          timer = undefined;
          if (runtime.isDisposed) return;
          started = true;
          void preloadCcStyleCommandUi({ runtime, observability }).catch(() => {
            // The first-use loader records the failure and keeps it visible in
            // runtime module state; an idle warm-up must never fail startup.
          });
        }, loading.idleDelayMs);
      };
      pi.on("session_start", schedule);
      pi.on("resources_discover", schedule);
      pi.on("session_info_changed", schedule);
      lifecycle.install({
        id: "command-ui-preload",
        install: () => ({ dispose: () => {
          if (timer) scheduler.clearTimer(timer);
          timer = undefined;
        } }),
        health: () => ({ status: started ? "ok" as const : "inactive" as const }),
      }, undefined);
    }
  }
  pi.on("session_start", () => {
    // A session start belongs to this runtime only. Its shutdown disposer
    // closes observability before Pi constructs the replacement runtime.
    if (configService) observability.configure(configService.active.performance);
  });

  return {
    configService,
    observability,
    lifecycle,
    scheduler,
    statuslineTranscriptCache,
  };
}

function shouldPreloadDiagnostics(loading: LoadingConfig): boolean {
  return loading.mode === "eager" ||
    (loading.mode === "balanced" && loading.preloadDiagnostics);
}
