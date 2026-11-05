import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { renderKeyValue, showInformationPanel, type InformationPanel, type InformationPanelState } from "pi-li-uikit/information-panel";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { codexAdapter } from "./src/adapters/codex.ts";
import { deepseekAdapter } from "./src/adapters/deepseek.ts";
import { grokAdapter } from "./src/adapters/grok.ts";
import { ModelCapacityRuntime } from "./src/runtime.ts";
import {
  codexHistoryWindow,
  computeBurn,
  formatCapacityReport,
  parseJsonl,
  type UsageSample,
} from "./stats.ts";

const CODEX_PROVIDER = "openai-codex";
const MIN_SAMPLE_INTERVAL_MS = 30_000;

interface PendingTraffic {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  maxContextTokens: number;
  requests: number;
}

function emptyTraffic(): PendingTraffic {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    maxContextTokens: 0,
    requests: 0,
  };
}

export default function piModelCapacity(pi: ExtensionAPI): void {
  const logPath = join(getAgentDir(), "codex-usage.jsonl");
  const createRuntime = () => new ModelCapacityRuntime({
    bus: pi.events,
    adapters: [codexAdapter, grokAdapter, deepseekAdapter],
  });
  let runtime = createRuntime();
  let retired = false;
  let pending = emptyTraffic();
  let lastSampleMs = 0;

  const bind = (ctx: ExtensionContext): void => {
    if (retired) { runtime = createRuntime(); retired = false; }
    runtime.bindContext(ctx);
  };

  const recordCodex = (): boolean => {
    const provider = runtime.providerSnapshot(CODEX_PROVIDER);
    if (provider.state !== "ready") return false;
    const window = codexHistoryWindow(provider);
    if (!window) return false;
    const sample: UsageSample = {
      ts: Math.floor(Date.now() / 1_000),
      usedPercent: window.usedPercent,
      resetAt: window.resetsAt ?? null,
      windowSeconds: window.windowSeconds ?? null,
      planType: provider.plan ?? null,
      inputTokens: pending.inputTokens,
      cacheReadTokens: pending.cacheReadTokens,
      outputTokens: pending.outputTokens,
      maxContextTokens: pending.maxContextTokens,
      requests: pending.requests,
    };
    try {
      appendFileSync(logPath, `${JSON.stringify(sample)}\n`, "utf8");
      pending = emptyTraffic();
      lastSampleMs = Date.now();
      return true;
    } catch {
      return false;
    }
  };

  pi.on("session_start", (_event, ctx) => bind(ctx));

  pi.on("session_shutdown", () => {
    runtime.dispose();
    retired = true;
    pending = emptyTraffic();
    lastSampleMs = 0;
  });

  pi.on("turn_end", (event, ctx) => {
    bind(ctx);
    if (ctx.model?.provider !== CODEX_PROVIDER) return;
    const usage = (event.message as { usage?: Record<string, number> }).usage;
    if (!usage) return;
    const input = finiteUsage(usage.input);
    const cacheRead = finiteUsage(usage.cacheRead);
    pending.inputTokens += input;
    pending.cacheReadTokens += cacheRead;
    pending.outputTokens += finiteUsage(usage.output);
    pending.maxContextTokens = Math.max(pending.maxContextTokens, input + cacheRead);
    pending.requests++;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    bind(ctx);
    if (ctx.model?.provider !== CODEX_PROVIDER || pending.requests === 0) return;
    if (Date.now() - lastSampleMs < MIN_SAMPLE_INTERVAL_MS) return;
    try {
      await runtime.refreshProvider(CODEX_PROVIDER);
      recordCodex();
    } catch {
      // Keep traffic pending until a later successful sample.
    }
  });

  pi.registerCommand("usage", {
    description: "Live capacity and usage from registered observation adapters",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      bind(ctx);
      const now = (): number => Math.floor(Date.now() / 1_000);
      const loadReport = async (): Promise<string> => {
        await runtime.refreshAll();
        recordCodex();
        const samples = parseJsonl(await readFile(logPath, "utf8").catch(() => ""));
        return formatCapacityReport(runtime.snapshot(), computeBurn(samples, now()), now());
      };
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        console.log(await loadReport());
        return;
      }

      const cached = runtime.snapshot();
      const observedAt = Math.max(0, ...cached.providers.map((provider) => provider.observedAt ?? 0));
      let report = observedAt > 0 ? formatCapacityReport(cached, computeBurn([], now()), now()) : "";
      let state: InformationPanelState | undefined = observedAt > 0
        ? { kind: "cached", detail: `${new Date(observedAt).toLocaleString()} · Refreshing…` }
        : { kind: "loading", detail: "Refreshing model capacity…" };
      let panel: InformationPanel | undefined;
      await showInformationPanel(ctx, {
        onCreate: (created) => { panel = created; },
        getView: () => ({
          title: "Usage",
          breadcrumbs: ["Model capacity"],
          state,
          renderBody: (width) => report.split("\n").flatMap((line) => {
            const split = line.indexOf(": ");
            const painted = split < 0 ? line : renderKeyValue(ctx.ui.theme, line.slice(0, split), line.slice(split + 2));
            return new Text(painted, 0, 0).render(width);
          }),
        }),
        onFirstRender: () => {
          void loadReport().then((fresh) => {
            if (panel?.isClosed) return;
            report = fresh;
            const failed = runtime.snapshot().providers.some((provider) => provider.state === "error" || provider.state === "stale" && provider.error);
            state = failed ? { kind: observedAt > 0 ? "cached" : "error", detail: "Some providers could not refresh; see details below." } : undefined;
            panel?.update();
          }).catch((error: unknown) => {
            if (panel?.isClosed) return;
            state = { kind: observedAt > 0 ? "cached" : "error", detail: `Refresh failed: ${error instanceof Error ? error.message : String(error)}` };
            panel?.update();
          });
        },
      });
    },
  });
}

function finiteUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
