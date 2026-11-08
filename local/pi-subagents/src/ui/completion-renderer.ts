import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, stripTerminalSequences, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderCollapsibleRows } from "pi-li-uikit/collapsible-block";
import { createCustomEntryDelegate } from "./custom-entry-delegate.js";

const COMPLETION_ENTRY_TYPE = "subagent-completion-v1";

interface CompletionPresentationV1 {
  readonly taskPath: string;
  readonly outcome: string;
  readonly reason: string;
  readonly summary: string;
  readonly result: string;
  readonly resultTruncated: boolean;
  readonly originalResultBytes?: number;
  readonly renderedResultBytes?: number;
  readonly totalTokens?: number;
  readonly durationMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function completionDetails(details: unknown): Record<string, unknown> | undefined {
  const outer = record(details);
  if (!outer) return undefined;
  const nested = record(outer.completion_details);
  if (nested) return nested;
  if (typeof outer.details_json !== "string") return undefined;
  try { return record(JSON.parse(outer.details_json)); } catch { return undefined; }
}

function xmlAttribute(content: string, name: string): string | undefined {
  const value = content.match(new RegExp(`\\b${name}="([^"]*)"`, "u"))?.[1];
  return value?.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}

function xmlElement(content: string, name: string): string | undefined {
  const value = content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u"))?.[1];
  return value?.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}

function presentation(content: string, details: unknown): CompletionPresentationV1 {
  const decoded = completionDetails(details);
  const completion = record(decoded?.completion);
  const usage = record(decoded?.usage);
  const admitted = typeof decoded?.task_admitted_at === "string" ? Date.parse(decoded.task_admitted_at) : Number.NaN;
  const started = typeof decoded?.task_started_at === "string" ? Date.parse(decoded.task_started_at) : admitted;
  const completed = typeof decoded?.completed_at === "string" ? Date.parse(decoded.completed_at) : Number.NaN;
  return {
    taskPath: typeof decoded?.task_path === "string" ? decoded.task_path : xmlAttribute(content, "task_path") ?? "subagent",
    outcome: typeof completion?.outcome === "string" ? completion.outcome : xmlAttribute(content, "outcome") ?? "completed",
    reason: typeof completion?.reason === "string" ? completion.reason : xmlAttribute(content, "reason") ?? "normal-final",
    summary: typeof completion?.summary === "string" ? completion.summary : xmlElement(content, "summary") ?? "Subagent finished",
    result: xmlElement(content, "result") ?? "",
    resultTruncated: decoded?.result_truncated === true || xmlAttribute(content, "result_truncated") === "true",
    ...(typeof decoded?.original_result_bytes === "number" ? { originalResultBytes: decoded.original_result_bytes } : {}),
    ...(typeof decoded?.rendered_result_bytes === "number" ? { renderedResultBytes: decoded.rendered_result_bytes } : {}),
    ...(typeof usage?.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? { durationMs: completed - started } : {}),
  };
}

function terminalText(value: string, multiline = false): string {
  const stripped = stripTerminalSequences(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  return multiline ? stripped : stripped.replace(/\s+/gu, " ").trim();
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/u, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

function duration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function messageText(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function outcomeGlyph(item: CompletionPresentationV1): { glyph: string; tone: "success" | "warning" | "error" } {
  if (item.outcome === "completed") return { glyph: "✓", tone: "success" };
  if (item.outcome === "interrupted") return { glyph: "◆", tone: "warning" };
  if (item.outcome === "blocked") return { glyph: "!", tone: "warning" };
  return { glyph: "✗", tone: "error" };
}

function renderCompletion(content: string, details: unknown, outputPad: number, theme: Theme): Component {
  const item = presentation(content, details);
  const glyph = outcomeGlyph(item);
  const metadata = [item.outcome, item.reason, item.totalTokens === undefined ? undefined : `${compactNumber(item.totalTokens)} tokens`, item.durationMs === undefined ? undefined : duration(item.durationMs)].filter(Boolean).join(" · ");
  class CompletionFallback implements Component {
    render(width: number): string[] {
      const safeMetadata = terminalText(metadata);
      const meta = safeMetadata ? ` ${theme.fg("dim", safeMetadata)}` : "";
      const row = `${theme.fg(glyph.tone, glyph.glyph)} ${theme.fg("accent", `Agent '${terminalText(item.taskPath)}'`)}${meta}`;
      return [truncateToWidth(row, Math.max(1, width), "…")];
    }
    invalidate(): void {}
  }
  const fallback = new Box(outputPad, 0);
  fallback.addChild(new CompletionFallback());
  return createCustomEntryDelegate(COMPLETION_ENTRY_TYPE, {
    version: 1,
    customType: COMPLETION_ENTRY_TYPE,
    completion: {
      ...item,
      taskPath: terminalText(item.taskPath),
      outcome: terminalText(item.outcome),
      reason: terminalText(item.reason),
      summary: terminalText(item.summary, true),
      result: terminalText(item.result, true),
    },
    options: { expanded: false, outputPad },
    theme,
  }, fallback);
}

export function registerSubagentMessageRenderersV1(pi: ExtensionAPI, viewed?: (details: unknown, content: string) => void): void {
  pi.registerMessageRenderer(COMPLETION_ENTRY_TYPE, (message, options, theme) => {
    const content=messageText(message.content), component=renderCompletion(content,message.details,options.outputPad,theme);
    return new Proxy(component,{get(target,key,receiver) {
      if(key==="handleMouse") return (event:TuiMouseEvent) => { const result=target.handleMouse?.(event); if(result?.handled&&event.type==="click"&&event.button==="left") viewed?.(message.details,content); return result; };
      const value=Reflect.get(target,key,receiver); return typeof value==="function"?value.bind(target):value;
    }});
  });
  pi.registerMessageRenderer("subagent-mailbox-v1", (message, options, _theme) => {
    const body = typeof message.content === "string" ? message.content : messageText(message.content);
    const lines = body.split("\n");
    const summary = lines.find((line: string) => line.length > 0) ?? "Mailbox message";
    const previewLines = lines.filter((line: string, i: number) => i > 0 && line.length > 0);
    const preview = previewLines.length > 0 ? previewLines : undefined;
    class MailboxBlock implements Component {
      render(width: number): string[] {
        return renderCollapsibleRows({ summary, preview, expanded: options.expanded }, width);
      }
      invalidate(): void {}
    }
    const box = new Box(options.outputPad, 0);
    box.addChild(new MailboxBlock());
    return box;
  });
}
