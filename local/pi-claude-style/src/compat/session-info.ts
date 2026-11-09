import { InteractiveMode } from "@earendil-works/pi-coding-agent";

interface SessionInfoModeHost {
  chatContainer?: unknown;
}

export interface SessionCapture {
  available: boolean;
  children: unknown[];
  error?: string;
}

/** Run Pi's own /session handler against a temporary capture container. */
export function captureSessionCommand(
  instance: unknown,
  invoke: () => void,
): SessionCapture {
  const host = instance as SessionInfoModeHost;
  const real = host.chatContainer;
  if (!real) return { available: false, children: [] };
  const children: unknown[] = [];
  host.chatContainer = { addChild: (child: unknown) => children.push(child) };
  let error: string | undefined;
  try {
    invoke();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    host.chatContainer = real;
  }
  return { available: true, children, error };
}

export function sessionInfoPrototype<T>(): T {
  return InteractiveMode.prototype as unknown as T;
}
