import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProcessHost } from "../host/process-host.js";
import type { ProcessManagerEditor } from "./manager.js";
import { ProcessStrip } from "./strip.js";

const STRIP_WIDGET_KEY = "pi-processes:strip";

export interface ProcessUiRuntime {
  readonly host: ProcessHost;
  readonly context: ExtensionContext;
}

export interface InstalledProcessUi {
  mount(runtime: ProcessUiRuntime): void;
  unmount(context?: ExtensionContext): void;
  open(processId?: string): void;
  requestRender(): void;
}

export function installProcessUi(pi: ExtensionAPI, getRuntime: () => ProcessUiRuntime | undefined): InstalledProcessUi {
  let runtime: ProcessUiRuntime | undefined;
  let managerOpen = false;
  let managerGeneration = 0;
  let closeActiveManager: (() => void) | undefined;
  let requestStripRender: (() => void) | undefined;
  let activeManager: ProcessManagerEditor | undefined;

  const closeManager = (): void => {
    managerGeneration++;
    managerOpen = false;
    const close = closeActiveManager;
    closeActiveManager = undefined;
    activeManager = undefined;
    close?.();
  };

  const open = (processId?: string): void => {
    const active = runtime ?? getRuntime();
    if (!active || active.context.mode !== "tui") return;
    if (managerOpen) {
      closeManager();
      if (!processId) return;
    }
    const generation = ++managerGeneration;
    managerOpen = true;
    const isCurrent = (): boolean => {
      const current = runtime ?? getRuntime();
      return managerGeneration === generation && current?.host === active.host && current.context === active.context;
    };
    void (import(new URL("./manager-view.js", import.meta.url).href) as Promise<typeof import("./manager-view.js")>).then(async ({ showProcessManager }) => {
      if (!isCurrent()) return;
      await showProcessManager(active, processId, isCurrent, (manager, close) => {
        closeActiveManager = close;
        activeManager = manager;
      });
    }).catch((error: unknown) => {
      if (isCurrent()) active.context.ui.notify(`Process manager unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
    }).finally(() => {
      if (managerGeneration !== generation) return;
      managerOpen = false;
      closeActiveManager = undefined;
      activeManager = undefined;
    });
  };

  pi.registerCommand("ps", {
    description: "Manage processes and inspect logs",
    handler: async (_args, context) => {
      if (context.mode !== "tui") {
        context.ui.notify("/ps requires TUI mode", "error");
        return;
      }
      const current = getRuntime() ?? runtime;
      if (!current) {
        context.ui.notify("pi-processes is not ready", "warning");
        return;
      }
      runtime = { host: current.host, context };
      open();
    },
  });

  return {
    mount(next) {
      runtime = next;
      next.context.ui.setWidget(STRIP_WIDGET_KEY, (tui) => {
        requestStripRender = () => tui.requestRender();
        return new ProcessStrip(next.host, (id) => open(id), next.context.ui.theme);
      }, { placement: "aboveEditor" });
    },
    unmount(context) {
      closeManager();
      const target = context ?? runtime?.context;
      target?.ui.setWidget(STRIP_WIDGET_KEY, undefined);
      runtime = undefined;
      requestStripRender = undefined;
      activeManager = undefined;
    },
    open,
    requestRender() {
      requestStripRender?.();
      activeManager?.refresh();
    },
  };
}
