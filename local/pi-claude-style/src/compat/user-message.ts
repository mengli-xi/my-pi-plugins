import { UserMessageComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Probe } from "../internals.ts";

export type AppendMessage = (this: unknown, message: AgentMessage, options?: unknown) => void;
export interface TimestampOwner { addMessageToChat?: AppendMessage; }

/** Shared by presentation ownership even when user-message decoration is off. */
export const TIMESTAMP_BINDING_PROBE: Probe = {
  id: "user-message.timestampBinding",
  needs: "InteractiveMode.addMessageToChat and chatContainer.children bind a user component to its message; entry timestamp comes from public SessionManager.getBranch",
  breaks: "用户消息继续显示，但不猜测发送时间",
  check: () => typeof interactiveUserMessagePrototype<TimestampOwner>().addMessageToChat === "function",
};

interface UserMessageHost {
  text?: unknown;
}

export function userMessageSourceCompat(
  instance: unknown,
): { text?: string; compatible: boolean } {
  const text = (instance as UserMessageHost).text;
  return typeof text === "string"
    ? { text, compatible: true }
    : { compatible: false };
}

export function userMessagePrototype<T>(): T {
  return UserMessageComponent.prototype as unknown as T;
}

/** user-message.timestampBinding owns this private append/container seam. */
export function interactiveUserMessagePrototype<T>(): T {
  return InteractiveMode.prototype as unknown as T;
}

/** The transcript's mounted children, read under user-message.timestampBinding. */
export function chatChildren(instance: unknown): unknown[] | undefined {
  const children = (instance as { chatContainer?: { children?: unknown } }).chatContainer?.children;
  return Array.isArray(children) ? children : undefined;
}

export function captureAppendedUserMessages(instance: unknown, invoke: () => void): {
  available: boolean;
  components: UserMessageComponent[];
} {
  const children = (instance as { chatContainer?: { children?: unknown } }).chatContainer?.children;
  const start = Array.isArray(children) ? children.length : 0;
  invoke();
  return {
    available: Array.isArray(children),
    components: Array.isArray(children)
      ? children.slice(start).filter((child): child is UserMessageComponent => child instanceof UserMessageComponent)
      : [],
  };
}
