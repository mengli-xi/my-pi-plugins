import type { ExtensionAPI, ExtensionFactory, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EFFECTIVE_CONFIG } from "./config/defaults.ts";
import { ConfigService } from "./config/service.ts";
import { installEditorChrome } from "./editor-chrome.ts";
import { installFullscreenHost } from "./host/fullscreen/install.ts";
import { installTranscriptFeature } from "./features/transcript/install.ts";
import { clipboardImageMarkdownTransformer } from "./image-marker.ts";
import { LifecycleManager } from "./lifecycle.ts";
import { CcStyleObservability } from "./observability.ts";
import { disposePresentationOwner, installPresentationOwner, ownedMarkdownTransformer } from "./presentation-owner.ts";
import { createRuntimeScope } from "./runtime-scope.ts";
import installStatusLine from "./statusline/install.ts";
import { CHILD_INITIAL_LINES } from "./statusline/initial-lines.ts";
import { UiScheduler } from "./ui-scheduler.ts";
import { installRetryRecording } from "./compat/retry-session.ts";
import { installTranscriptRunRecording } from "./run-recording.ts";

export interface ClaudeStyleChildOptions {
  target: "subagent" | "side-chat";
  taskName: string;
  returnLabel: string;
  readOnlyStatusline: boolean;
  /** Attach before InteractiveMode.init(); await detach before stopping the view. */
  viewLifecycle?: {
    onAttach(attach: () => void): () => void;
    onDetach(detach: () => Promise<void>): () => void;
  };
}

/** Install at child assembly: real run recording is session-owned; only presentation belongs to a view. */
export function createClaudeStyleChildExtension(options: ClaudeStyleChildOptions): ExtensionFactory {
  return (pi) => {
    const initialConfig = new ConfigService({ readOnly: true }).active;
    const runRecording = installTranscriptRunRecording(pi, initialConfig.transcript.separators);
    const retryRecording = initialConfig.features.working ? installRetryRecording(pi) : undefined;
    let resolvers: ToolRendererResolver[] = [];
    // Register one resolver with Pi, rather than accumulating one per UI entry.
    pi.registerToolRenderer((name, next) => {
      let resolve = next;
      for (const resolver of resolvers) {
        const previous = resolve;
        resolve = () => resolver(name, previous);
      }
      return resolve();
    });
    let detach: (() => Promise<void>) | undefined;
    const attach = () => {
      if (detach) return;
      const subscriptions: Array<() => void> = [];
      const api: ExtensionAPI = new Proxy(pi, {
        get(target, key) {
          if (key === "on") return (...args: Parameters<ExtensionAPI["on"]>) => {
            const unsubscribe = (target.on as (...args: any[]) => () => void)(...args);
            subscriptions.push(unsubscribe);
            return unsubscribe;
          };
          if (key === "registerToolRenderer") return (resolver: ToolRendererResolver) => resolvers.push(resolver);
          return Reflect.get(target, key);
        },
      });
      installPresentationOwner(api);
      api.registerMarkdownTransformer(ownedMarkdownTransformer(api, clipboardImageMarkdownTransformer));
      const runtime = createRuntimeScope();
      const lifecycle = new LifecycleManager();
      const effective = new ConfigService({ readOnly: true }).active;
      const observability = new CcStyleObservability();
      const scheduler = new UiScheduler(observability);
      // The fullscreen adaptations Pinned Layout's child factory used to bring.
      const fullscreen = installFullscreenHost(api, () => effective.layout);
      const chrome = installEditorChrome(api, {
        topRightLabel: options.taskName,
        bottomLabel: options.returnLabel,
        publishImageSource: false,
      });
      const statusline = installStatusLine(api, (name, action) => observability.measure(name, action), {
        interactiveSlots: !options.readOnlyStatusline,
        isolatedFrame: true,
        ...(options.target === "side-chat"
          ? { acceptedContributionKeys: ["side-chat"] }
          : {
            acceptContributions: false,
            initialLines: CHILD_INITIAL_LINES,
          }),
      });
      installTranscriptFeature({
        pi: api,
        config: {
          ...effective.transcript,
          enabled: effective.features.transcript,
          working: { ...effective.working, enabled: effective.features.working },
          goal: { ...effective.transcript.goal, enabled: false },
        },
        observability, lifecycle, runtime, scheduler,
        loading: { ...(effective.loading ?? DEFAULT_EFFECTIVE_CONFIG.loading), mode: "minimal", preloadDiagnostics: false },
        registerCommands: false,
        presentationOnly: true,
        runRecording, retryRecording,
      });
      runtime.markReady();
      detach = async () => {
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        resolvers = [];
        await statusline.dispose();
        chrome.dispose();
        fullscreen.dispose();
        scheduler.dispose();
        await runtime.dispose();
        await lifecycle.teardownAll();
        disposePresentationOwner(api);
      };
    };
    const detachView = async () => {
      const release = detach;
      if (!release) return;
      await release();
      detach = undefined;
    };
    if (options.viewLifecycle) {
      const stopAttach = options.viewLifecycle.onAttach(attach);
      const stopDetach = options.viewLifecycle.onDetach(detachView);
      pi.on("session_shutdown", async () => {
        stopAttach(); stopDetach();
        await detachView();
      });
    } else {
      attach();
      pi.on("session_shutdown", detachView);
    }
  };
}
