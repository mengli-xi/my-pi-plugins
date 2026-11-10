import { BtwController } from "./btw.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { assertSdkOnlyEnvironment, DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { MainContextSource } from "./effective-context.ts";
import { createBtwStatus } from "./statusline.ts";
const SIDE_ACTIONS = ["destroy"] as const;
const BTW_ACTIONS = ["cancel"] as const;

export function parseBtwAction(args: string): { kind: "open" } | { kind: typeof BTW_ACTIONS[number] } | { kind: "ask"; question: string } {
  const question = args.trim();
  if (!question) return { kind: "open" };
  const action = BTW_ACTIONS.find(action => action === question.toLowerCase());
  return action ? { kind: action } : { kind: "ask", question };
}
type SideAction = "open" | typeof SIDE_ACTIONS[number];

export function parseAction(args: string): SideAction {
  const value = args.trim().toLowerCase();
  if (!value) return "open";
  const action = SIDE_ACTIONS.find(action => action === value);
  if (action) return action;
  throw new Error("Usage: /side [destroy]");
}

function reportError(ctx: ExtensionContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(message, "error");
  if (ctx.mode !== "tui") console.error(`[pi-side-chat] ${message}`);
}

export default async function sideChatExtension(pi: ExtensionAPI): Promise<void> {
  let config = DEFAULT_CONFIG;
  try {
    config = loadConfig();
    assertSdkOnlyEnvironment();
  } catch (error) {
    // Stock Pi exits on factory errors. Keep Main available, without installing
    // any Side runtime, and repeat the diagnostic when a Side entry is used.
    let notified = false;
    pi.on("session_start", (_event, ctx) => {
      if (notified) return;
      notified = true;
      reportError(ctx, error);
    });
    for (const name of ["side", "btw"] as const) {
      pi.registerCommand(name, {
        description: "Side Chat 配置无效；请按错误提示修改后重启 pi",
        getArgumentCompletions: (prefix) => (name === "side" ? SIDE_ACTIONS : BTW_ACTIONS)
          .filter(value => value.startsWith(prefix.toLowerCase()))
          .map(value => ({ value, label: value })),
        handler: async (_args, ctx) => { reportError(ctx, error); },
      });
    }
    pi.registerShortcut(config.shortcut as KeyId, {
      description: "Side Chat 配置无效；请按错误提示修改后重启 pi",
      handler: async ctx => { reportError(ctx, error); },
    });
    return;
  }
  const source = new MainContextSource(pi);
  const { SdkSideCoordinator } = await import("./sdk-coordinator.ts");
  const coordinator = new SdkSideCoordinator(pi, source);
  // Side owns Main's terminal during handoff, so the answer panel asks the
  // coordinator before it opens over an editor Main is about to restore.
  const btw = new BtwController(undefined, createBtwStatus(pi), {
    occupied: () => coordinator.mainTerminalOccupied(),
  });

  pi.on("session_start", (_event, ctx) => {
    btw.startSession();
    coordinator.rememberContext(ctx);
  });
  pi.on("agent_settled", () => {
    coordinator.notifyMainSettled();
  });
  pi.on("session_shutdown", async (event) => {
    btw.shutdown();
    await coordinator.shutdown(event.reason);
  });

  pi.registerCommand("btw", {
    description: "Ask one context-aware side question without tools or transcript changes",
    getArgumentCompletions: (prefix) => BTW_ACTIONS
      .filter((value) => value.startsWith(prefix.toLowerCase()))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const request = parseBtwAction(args);
        if (request.kind === "cancel") {
          if (!btw.cancel()) ctx.ui.notify("No BTW question is running", "info");
          return;
        }
        if (request.kind === "open") {
          await btw.showBrowser(ctx);
          return;
        }
        // Release the command dispatcher here: Pi reads the next input only after
        // this handler returns, so awaiting the answer would also delay `/btw cancel`.
        void btw.start(request.question, ctx, () => source.snapshot(ctx), (error) => {
          reportError(ctx, error);
        });
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerCommand("side", {
    description: "Open, resume, or destroy an ephemeral Side Chat (/side [destroy])",
    getArgumentCompletions: (prefix) => SIDE_ACTIONS
      .filter((value) => value.startsWith(prefix.toLowerCase()))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const action = parseAction(args);
        if (action === "destroy") {
          const destroyed = await coordinator.destroy();
          ctx.ui.notify(destroyed ? "Side Chat destroyed" : "No Side Chat is running", "info");
          return;
        }
        await coordinator.toggle(ctx);
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });

  pi.registerShortcut(config.shortcut as KeyId, {
    description: "Toggle Side Chat",
    handler: async (ctx) => {
      try {
        await coordinator.toggle(ctx);
      } catch (error) {
        reportError(ctx, error);
      }
    },
  });
}
