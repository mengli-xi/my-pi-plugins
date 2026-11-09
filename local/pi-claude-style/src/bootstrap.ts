import { installPresentationOwner } from "./presentation-owner.ts";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { createServices } from "./bootstrap/create-services.ts";
import { DEFAULT_EFFECTIVE_CONFIG } from "./config/defaults.ts";
import { installShellFeatures } from "./bootstrap/install-shell-features.ts";
import { loadConfig } from "./config.ts";
import { installTranscriptFeature } from "./features/transcript/install.ts";
import type { LifecycleManager } from "./lifecycle.ts";
import { createRuntimeScope, installRuntimeModule } from "./runtime-scope.ts";
import { installClaudeStyleChildCapability } from "./child-capability.ts";

/** Every shutdown retires this extension runtime and all resources it owns. */
export async function teardownLifecycleForEvent(
  lifecycle: LifecycleManager,
  _event: Pick<SessionShutdownEvent, "reason">,
): Promise<void> {
  await lifecycle.teardownAll();
}

/** Composition root: construct one runtime, install feature seams, then return. */
export default async function claudeStyleExtension(pi: ExtensionAPI): Promise<void> {
  const moduleBase = dirname(dirname(fileURLToPath(import.meta.url)));
  const capability = installClaudeStyleChildCapability(basename(moduleBase) === "dist" ? moduleBase : join(moduleBase, "dist"));
  installPresentationOwner(pi);
  const runtime = createRuntimeScope();
  runtime.beginEagerInstall();
  const {
    configService,
    observability,
    lifecycle,
    scheduler,
    statuslineTranscriptCache,
  } = createServices(pi, runtime);
  const effective = configService?.active;

  // Shell ownership is independent of transcript rendering. A disabled
  // transcript can still retain the pinned layout and generic statusline host.
  const loadingMode = effective?.loading.mode ?? "eager";
  await installRuntimeModule(
    runtime,
    loadingMode,
    "shell-features",
    async () => true,
    () => installShellFeatures(
      pi,
      lifecycle,
      observability,
      statuslineTranscriptCache,
      () => effective?.layout ?? DEFAULT_EFFECTIVE_CONFIG.layout,
    ),
  );

  // Pi invokes a new factory after every shutdown reason. The outgoing scope
  // must close before any replacement installs its own timers and patches.
  pi.on("session_start",(_event,ctx)=>capability.bind(ctx));
  pi.on("session_shutdown", async (event,ctx) => {
    capability.release(ctx);
    await runtime.dispose(event.reason);
    capability.dispose();
  });

  const legacy = loadConfig();
  const config = effective ? {
    ...effective.transcript,
    enabled: effective.features.transcript,
    working: { ...effective.working, enabled: effective.features.working },
  } : legacy.config;
  if (!config.enabled) {
    runtime.markReady();
    return;
  }

  const installTranscript = () =>
    installTranscriptFeature({
      pi,
      config,
      configService,
      observability,
      lifecycle,
      runtime,
      scheduler,
      loading: effective?.loading ?? {
        mode: "balanced",
        idleDelayMs: 250,
        preloadOverlays: false,
        preloadDiagnostics: false,
      },
      legacyConfigError: legacy.error,
    });
  await installRuntimeModule(
    runtime,
    loadingMode,
    "transcript-feature",
    async () => true,
    installTranscript,
  );
  runtime.markReady();
}
