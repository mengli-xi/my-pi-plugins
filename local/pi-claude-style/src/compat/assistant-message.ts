import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";

interface ContentContainer {
  children: Component[];
}

interface MouseRegionHost {
  child?: Component;
}

interface AssistantMessageHost {
  contentContainer?: ContentContainer;
  outputPad?: number;
  isStreaming?: boolean;
  lastMessage?: AssistantMessage;
}

export interface AssistantPresentationState {
  children: Component[] | undefined;
  outputPad: number | undefined;
  isStreaming: boolean | undefined;
}

/** Unsafe Pi 1.2 instance reads live only in this compat adapter. */
export function assistantPresentationState(instance: unknown): AssistantPresentationState {
  const host = instance as AssistantMessageHost;
  return {
    children: host.contentContainer?.children,
    outputPad: host.outputPad,
    isStreaming: host.isStreaming,
  };
}

/** Keep Pi's redraw/toggle source separate from our live presentation clone. */
export function retainAssistantSourceMessage(
  instance: unknown,
  message: AssistantMessage,
): boolean {
  const host = instance as AssistantMessageHost;
  if (!("lastMessage" in host)) return false;
  host.lastMessage = message;
  return true;
}

/**
 * Pi 1.2 wraps native thinking children in MouseRegion. The wrapper keeps its
 * child in the TypeScript-private `child` field; if that contract changes we
 * fail closed instead of classifying an unknown wrapper as assistant text.
 */
export interface AssistantPresentationChildCompat {
  component: Component | undefined;
  preserveWrapper(replacement: Component): Component;
}

export function assistantPresentationChildCompat(
  component: Component,
): AssistantPresentationChildCompat {
  const name = (component as { constructor?: { name?: unknown } }).constructor?.name;
  if (name !== "MouseRegion") {
    return { component, preserveWrapper: (replacement) => replacement };
  }
  const host = component as MouseRegionHost;
  const child = host.child;
  return {
    component: child && typeof child.render === "function" ? child : undefined,
    preserveWrapper(replacement) {
      host.child = replacement;
      return component;
    },
  };
}

export function markdownDefaultStyleCompat(
  child: object,
): { compatible: boolean; styled: boolean } {
  if (!("defaultTextStyle" in child)) return { compatible: false, styled: false };
  const style = (child as { defaultTextStyle?: unknown }).defaultTextStyle;
  return { compatible: true, styled: style !== undefined && style !== null };
}

export function assistantMessagePrototype<T>(): T {
  return AssistantMessageComponent.prototype as unknown as T;
}
