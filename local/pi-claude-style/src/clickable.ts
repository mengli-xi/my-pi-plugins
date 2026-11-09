/** Content actions for Pi fullscreen mouse clicks. */
import {
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/**
 * Run `onClick` for a completed left click with component-local coordinates
 * (`row` is the line within the component, `col` its column). Pi owns gesture
 * classification: presses, drags, selection, capture and wheel are never
 * claimed. An action that throws reports the click as unused.
 */
export function onLeftClick(
  event: TuiMouseEvent,
  onClick: (row: number, col: number) => boolean,
): TuiMouseEventResult | undefined {
  if (event.type !== "click" || event.button !== "left") return undefined;
  try {
    return onClick(event.y, event.x) ? { handled: true } : undefined;
  } catch {
    return undefined;
  }
}

class ClickableComponent implements Component {
  private readonly child: Component;
  private readonly onClick: (row: number, col: number) => boolean;

  constructor(
    child: Component,
    onClick: (row: number, col: number) => boolean,
  ) {
    this.child = child;
    this.onClick = onClick;
  }

  render(width: number): string[] {
    return this.child.render(width);
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const childResult = this.child.handleMouse?.(event);
    if (childResult?.handled || childResult?.capture || childResult?.focus) {
      return childResult;
    }
    return onLeftClick(event, this.onClick) ?? childResult;
  }
}

/**
 * Wrap a row so clicking it runs `onClick`. Wrapping a row that renders
 * nothing is harmless — it occupies no line, so no click can land on it.
 */
export function clickable(
  child: Component,
  onClick: (row: number, col: number) => boolean,
): Component {
  return new ClickableComponent(child, onClick);
}
