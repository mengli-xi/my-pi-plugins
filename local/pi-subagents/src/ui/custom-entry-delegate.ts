import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/** Pi fullscreen delivers clicks through `handleMouse`; the delegate passes them on. */
interface ClickableComponent extends Component {
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/** Copied synchronous presentation contract owned by the presentation host. */
const REGISTRY_KEY = Symbol.for("pi.claude-style.custom-entry-presentations.v1");

interface PresentationProvider {
  version: 1;
  render(input: unknown): Component | undefined;
}

function resolveProvider(customType: string): PresentationProvider["render"] | undefined {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const value = globals[REGISTRY_KEY];
  if (
    typeof value !== "object" || value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !((value as { providers?: unknown }).providers instanceof Map)
  ) return undefined;
  const provider = (value as { providers: Map<string, unknown> }).providers.get(customType);
  if (
    typeof provider !== "object" || provider === null ||
    (provider as { version?: unknown }).version !== 1 ||
    typeof (provider as { render?: unknown }).render !== "function"
  ) return undefined;
  return (provider as PresentationProvider).render;
}

/** Resolve on every operation so late load, reload, and teardown remain safe. */
export function createCustomEntryDelegate(
  customType: string,
  request: unknown,
  fallback: Component,
): ClickableComponent {
  let provider: PresentationProvider["render"] | undefined;
  let component: Component | undefined;
  let failedProvider: PresentationProvider["render"] | undefined;

  const current = (): Component => {
    const next = resolveProvider(customType);
    if (!next || next === failedProvider) {
      provider = next;
      component = undefined;
      return fallback;
    }
    // A provider may be installed before its view owner is bound. Retry an
    // unavailable result; only a ready component or a thrown failure is cached.
    if (next !== provider || !component) {
      provider = next;
      component = undefined;
      try {
        component = next(request);
      } catch {
        failedProvider = next;
      }
    }
    return component ?? fallback;
  };

  return {
    render(width: number): string[] {
      const selected = current();
      try {
        return selected.render(width);
      } catch {
        if (selected !== fallback) {
          failedProvider = provider;
          component = undefined;
          try { return fallback.render(width); } catch { /* fail open */ }
        }
        return [];
      }
    },
    invalidate(): void {
      try { current().invalidate?.(); } catch { /* presentation is optional */ }
    },
    handleInput(data: string): void {
      try { current().handleInput?.(data); } catch { /* presentation is optional */ }
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      try { return current().handleMouse?.(event); } catch { return undefined; }
    },
  };
}
