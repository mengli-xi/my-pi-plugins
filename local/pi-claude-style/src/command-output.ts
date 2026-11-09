import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import { onLeftClick } from "./clickable.ts";
import type { TextOpener } from "./openers.ts";
import type { CustomMessagesConfig } from "./types.ts";

/**
 * Displayed custom messages whose producers register no renderer. CC draws
 * them in the transcript's compact style; every other type keeps Pi's box.
 * A producer that starts registering its own renderer must be removed here:
 * Pi uses the first extension's renderer for a type.
 */
export const COMPACT_MESSAGE_TYPES = [
  // pi-claude-style: /internals and drift reports, /cc-style without a TUI.
  "internals",
  "cc-style.command-output",
  "cc-style.command-error",
  // pi-fork-update: the batch report.
  "fork-update",
  // pi-goal: the budget wrap-up steer.
  "goal-budget-wrap-up",
  // pi-mcp-adapter: what an MCP app UI sent into the session.
  "mcp-ui-prompt",
  "mcp-ui-intent",
  "mcp-ui-context",
  // pi-mcp-adapter: background OAuth completion/failure and next action.
  "mcp-oauth-status",
] as const;

interface CustomMessageLike {
  customType?: unknown;
  content?: unknown;
  details?: unknown;
}



const ANSI = /\x1b\[[0-9;]*m/;

export function hasAnsi(text: string): boolean {
  return ANSI.test(text);
}

/**
 * The expanded body behind a custom message, or nothing if it carries none.
 *
 * An extension that wants a readable popup puts markdown in `details.markdown`;
 * anything else is shown as its own JSON. Pretty-printing beats dropping it —
 * the detail was attached to be looked at, and a raw object is still readable.
 */
function detailBody(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") return details.trim() || undefined;
  if (typeof details === "object") {
    const markdown = (details as { markdown?: unknown }).markdown;
    if (typeof markdown === "string" && markdown.trim()) return markdown;
  }
  try {
    return `\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``;
  } catch {
    return undefined;
  }
}

/** A custom message whose `details` can be opened. */
class ExpandableMessage implements Component {
  private readonly child: Component;
  private readonly heading: string;
  private readonly body: string;
  private readonly openText: TextOpener;

  constructor(child: Component, heading: string, body: string, openText: TextOpener) {
    this.child = child;
    this.heading = heading;
    this.body = body;
    this.openText = openText;
  }

  render(width: number): string[] {
    return this.child.render(width);
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, () => this.open());
  }

  private open(): boolean {
    return this.openText(this.heading, this.body, {
      glyph: "▸",
      tone: "text",
      // Text carrying ANSI has already been rendered by whoever produced it —
      // pi's own `/session` report is painted through the theme before this
      // ever sees it. Handing that to Markdown would eat the escapes and
      // reflow a table that was laid out in columns.
      format: hasAnsi(this.body) ? "plain" : undefined,
    });
  }
}

/** The text an extension put in its command result. */
function messageText(message: CustomMessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text"
    )
    .map((block) => block.text)
    .join("\n");
}

function normalizeHeading(value: string): string {
  // Commands are hyphenated but their headings are usually title case with
  // spaces, so "/ctx-flush" and "# Ctx Flush" have to compare equal.
  return value
    .replace(/^[/#\s]+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Drops a leading Markdown heading that only repeats the command name.
 *
 * Extensions commonly open their command output with `## /the-command`, which
 * lands directly under the label Pi already prints, costing two rows to say
 * one thing. A heading that says something else is left alone.
 */
export function stripEchoedHeading(text: string, label: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return text;
  const heading = lines[first]!.trim();
  if (!heading.startsWith("#")) return text;
  if (normalizeHeading(heading) !== normalizeHeading(label)) return text;
  const rest = lines.slice(first + 1);
  while (rest.length > 0 && rest[0]!.trim().length === 0) rest.shift();
  return rest.join("\n");
}

/**
 * Command output rendered like the rest of the transcript: the command name on
 * its own row, the body indented under it, no filled box.
 *
 * Pi's default draws a full-width background block with a blank row above and
 * below the content, a label row, and a blank row after it — five rows of
 * chrome around what is often a single sentence.
 */
export class CommandOutputComponent implements Component {
  private readonly label: string;
  private readonly text: string;
  private readonly markdownTheme: unknown;
  private readonly config: CustomMessagesConfig;
  private readonly theme: Theme;
  private body: Markdown | undefined;

  constructor(
    label: string,
    text: string,
    markdownTheme: unknown,
    config: CustomMessagesConfig,
    theme: Theme,
  ) {
    this.label = label;
    this.text = config.stripEchoedHeading
      ? stripEchoedHeading(text, label)
      : text;
    this.markdownTheme = markdownTheme;
    this.config = config;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const theme = this.theme;
    const paint = (color: string, text: string) => {
      try {
        return theme.fg(color as never, text);
      } catch {
        return text;
      }
    };
    const marker = this.config.marker;
    const indent = " ".repeat(marker.length + 1);
    const header = `${paint("customMessageLabel", marker)} ${
      paint("customMessageLabel", this.label)
    }`;
    if (!this.text.trim()) return [header];

    const bodyWidth = Math.max(1, safeWidth - indent.length);
    if (!this.body) {
      this.body = new Markdown(
        this.text,
        0,
        0,
        this.markdownTheme as never,
        { color: (text: string) => paint("customMessageText", text) },
      );
    }
    const lines = this.body.render(bodyWidth);
    return [
      header,
      ...lines.map((line) => (line.length > 0 ? `${indent}${line}` : line)),
    ];
  }

  invalidate(): void {
    this.body?.invalidate();
  }
}

/**
 * Draw the known displayed custom messages through Pi's public message
 * renderer: the command name on its own row, the body indented under it, no
 * filled box, and a click opening `details` when there are any. Pi's own box
 * spends five rows of chrome on what is often one sentence.
 */
export function registerCompactMessageRenderers(
  pi: ExtensionAPI,
  config: CustomMessagesConfig,
  openText: TextOpener = () => false,
): () => void {
  if (!config.enabled || config.style === "native") return () => {};
  let active = true;
  for (const customType of COMPACT_MESSAGE_TYPES) {
    pi.registerMessageRenderer(customType, (message, _options, theme) => {
      // Undefined hands the message back to Pi's own box.
      if (!active) return undefined;
      const markdownTheme = {
        ...getMarkdownTheme(),
        codeBlockIndent: pi.getSettings().markdown?.codeBlockIndent ?? getMarkdownTheme().codeBlockIndent,
      };
      const rendered = new CommandOutputComponent(customType, messageText(message), markdownTheme, config, theme);
      const body = detailBody(message.details);
      return body ? new ExpandableMessage(rendered, customType, body, openText) : rendered;
    });
  }
  return () => { active = false; };
}
