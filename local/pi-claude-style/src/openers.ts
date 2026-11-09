/**
 * Where a clicked row sends the user.
 *
 * Rows are built deep inside tool-definition decorators and assistant-message
 * patching, several factory layers away from the extension context that can
 * actually open a popup. Rather than thread a callback through every one of
 * those signatures, activation registers the openers here and rows call them.
 *
 * They are registered once per activation and cleared on shutdown, so a click
 * arriving from a stale row after a reload declines instead of opening a popup
 * against a dead session.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolImagePreview } from "./image-preview.ts";

/**
 * How the popup should present the text it was handed. Thinking is Markdown
 * and reads as prose; a tool's output is neither, so it is shown verbatim.
 */
export interface LiveTextPanelSnapshot {
  body: string;
  note?: string;
}

export interface LiveTextSource {
  snapshot(): string;
  subscribe(listener: (body: string) => void): () => void;
  /** Optional unified popup snapshot for live title metadata such as elapsed time. */
  panelSnapshot?(): LiveTextPanelSnapshot;
  subscribePanel?(listener: (snapshot: LiveTextPanelSnapshot) => void): () => void;
}

export interface TextOpenOptions {
  format?: "markdown" | "plain";
  /**
   * Draw the popup's body with a component rather than from the text. The
   * text is still carried, as what a copy puts on the clipboard and as the
   * fallback when the component cannot draw.
   */
  renderBody?: (width: number, theme: Theme) => string[];
  /** Drawn before the heading. */
  glyph?: string;
  tone?: "thinkingText" | "text";
  /** Keep an already mounted panel in sync with a streaming document. */
  live?: LiveTextSource;
  /** Markdown body only: drop ``` marker rows the way CC's transcript does. */
  hideCodeFenceMarkers?: boolean;
  /** Release request-owned resources even when lazy mounting is declined or fails. */
  onClose?: () => void;
}

/** Both return false when there is nothing to show, leaving the click unused. */
export type GroupOpener = (toolCallId: string) => boolean;
export type TextOpener = (
  heading: string,
  body: string,
  options?: TextOpenOptions,
) => boolean;
export type ImageOpener = (images: readonly ToolImagePreview[]) => boolean;

/** Runtime-scoped callbacks; no session/UI context survives in module globals. */
export class RuntimeOverlayOpeners {
  private openGroup: GroupOpener | undefined;
  private openText: TextOpener | undefined;
  private openImages: ImageOpener | undefined;

  set(openers: {
    group?: GroupOpener;
    text?: TextOpener;
    images?: ImageOpener;
  }): void {
    this.openGroup = openers.group;
    this.openText = openers.text;
    this.openImages = openers.images;
  }

  clear(): void {
    this.openGroup = undefined;
    this.openText = undefined;
    this.openImages = undefined;
  }

  openGroupFor = (toolCallId: string): boolean =>
    this.openGroup ? this.openGroup(toolCallId) : false;

  openTextFor = (
    heading: string,
    body: string,
    options?: TextOpenOptions,
  ): boolean => {
    if (!this.openText) return false;
    const current = options?.live?.snapshot() ?? body;
    if (current.trim().length === 0) return false;
    return this.openText(heading, current, options);
  };

  openImagesFor = (images: readonly ToolImagePreview[]): boolean =>
    images.length > 0 && this.openImages ? this.openImages(images) : false;
}
