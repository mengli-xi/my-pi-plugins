import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { onLeftClick } from "./clickable.ts";
import type { TextOpener } from "./openers.ts";
import type { NativeToolOutputConfig } from "./types.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

const isBlank = (line: string): boolean => line.replace(ANSI, "").trim() === "";

/** Leading whitespace of a line, so a hint can sit under what it summarises. */
function indentOf(line: string): string {
  const plain = line.replace(ANSI, "");
  return plain.slice(0, plain.length - plain.trimStart().length);
}

export interface FoldedOutput {
  /** The rows to draw, always fewer than the cap so the hint fits. */
  lines: string[];
  /** How many non-blank rows are not being shown. */
  hidden: number;
}

/**
 * Fold `lines` to at most `maxLines` rows.
 *
 * Blank rows are dropped first: a tool that separates its sections with them
 * would otherwise spend the whole budget saying nothing, and the point of the
 * fold is to show the most informative rows the tool led with. Returns
 * undefined when the output already fits, which is what keeps a short result
 * byte-for-byte what the tool drew.
 */
export function foldOutput(
  lines: readonly string[],
  maxLines: number,
): FoldedOutput | undefined {
  if (maxLines <= 0) return { lines: [], hidden: lines.filter((line) => !isBlank(line)).length };
  if (lines.length <= maxLines) return undefined;

  const meaningful = lines.filter((line) => !isBlank(line));
  if (meaningful.length <= maxLines) return { lines: [...meaningful], hidden: 0 };

  const kept = meaningful.slice(0, maxLines - 1);
  return { lines: kept, hidden: meaningful.length - kept.length };
}

/** `Process` / `Process · output` — what the popup is titled. */
export function outputHeading(label: string, args: unknown): string {
  const action = (args as { action?: unknown } | undefined)?.action;
  return typeof action === "string" && action.trim().length > 0
    ? `${label} · ${action.trim()}`
    : label;
}

/** The text blocks of a tool result, which is what the model was given. */
export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => block.text)
    .join("\n")
    .trimEnd();
}

export interface FoldedResultOptions {
  maxLines: number;
  /** Title of the popup the row opens. */
  heading: string;
  /** The result as the model received it: the popup's text, and what a copy takes. */
  body: string;
  /**
   * The tool drawing its own result, expanded, at the popup's width. The row
   * is a summary of something Pi can already draw properly; the popup shows
   * that rather than a flattened copy of it.
   */
  renderExpanded?: (width: number, theme: Theme) => string[];
  getTheme: () => Theme | undefined;
  openText: TextOpener;
}

/** The tool's own result component, capped and clickable. */
export class FoldedResultComponent implements Component {
  private readonly child: Component;
  private readonly options: FoldedResultOptions;
  /** Whether the last render actually hid anything; only then is a click useful. */
  private folded = false;

  constructor(child: Component, options: FoldedResultOptions) {
    this.child = child;
    this.options = options;
  }

  render(width: number): string[] {
    const lines = this.child.render(width);
    const folded = foldOutput(lines, this.options.maxLines);
    if (!folded) {
      this.folded = false;
      return lines;
    }
    this.folded = folded.hidden > 0;
    if (folded.hidden === 0) return folded.lines;

    const anchor = folded.lines[folded.lines.length - 1] ?? "";
    return [...folded.lines, this.hint(folded.hidden, indentOf(anchor))];
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  /**
   * Anywhere on the row opens it: there is nothing else on these lines.
   *
   * Not only when this wrapper hid something. The tool collapses its own
   * result long before the cap applies — a `process output` call shows a
   * status line and keeps a screen of the command's output to itself — so a
   * row that fits is still a summary of something, and the popup is the only
   * way to the rest of it.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, () => this.options.openText(this.options.heading, this.options.body, {
      format: "plain",
      glyph: "▸",
      tone: "text",
      renderBody: this.options.renderExpanded,
    }));
  }

  private hint(hidden: number, indent: string): string {
    const text = `… +${hidden} line${hidden === 1 ? "" : "s"} · click to view`;
    const theme = this.options.getTheme();
    if (!theme) return `${indent}${text}`;
    try {
      return `${indent}${theme.fg("dim", text)}`;
    } catch {
      return `${indent}${text}`;
    }
  }
}

/** Cap selected native renderers through Pi's public presentation resolver. */
export function installFoldedNativeOutput(
  pi: ExtensionAPI,
  config: NativeToolOutputConfig,
  getTheme: () => Theme | undefined,
  openText: TextOpener = () => false,
): () => void {
  const tools = new Set(config.tools.map((tool) => tool.toLowerCase()));
  if (!config.enabled || tools.size === 0) return () => {};
  let active = true;
  pi.registerToolRenderer((toolName, next) => {
    const renderers = next();
    const renderer = renderers?.renderResult;
    if (!active || !renderer || !tools.has(toolName.toLowerCase())) return renderers;
    const label = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    return {
      ...renderers,
      renderShell: config.compactShell ? "self" : renderers.renderShell,
      renderResult(result, options, theme, context) {
        const component = renderer(result, options, theme, context);
        if (config.respectExpanded && options.expanded) return component;
        return new FoldedResultComponent(component, {
          maxLines: config.maxLines,
          heading: outputHeading(label, context.args),
          body: resultText(result.content),
          renderExpanded: (width, cardTheme) =>
            renderer(result, { ...options, expanded: true }, cardTheme, context).render(width),
          getTheme,
          openText,
        });
      },
    };
  });
  return () => { active = false; };
}
