import {
  CustomEditor,
  UserMessageComponent,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  findSkillMentions,
  parseSkillCommandInvocation,
  type SkillMention,
  type SkillRef,
} from "./skills.ts";

export const USER_MESSAGE_TRANSFORMS_KEY = Symbol.for("ui-pack.user-message-render-transforms.v1");

const EDITOR_FACTORY_MARK = Symbol.for("pi-skills.editorFactory.v1");
const PRESENTATION_STATE_KEY = Symbol.for("pi-skills.presentationState.v1");
const USER_MESSAGE_TRANSFORM_ID = Symbol.for("pi-skills.user-message-transform.v1");
const FALLBACK_USER_MESSAGE_HOST = Symbol.for("pi-skills.user-message-host.v1");
const FALLBACK_USER_MESSAGE_PATCH = Symbol.for("pi-skills.user-message-patch.v1");
const ANSI_OR_CONTROL_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07|\][^\x07]*(?:\x07|\x1b\\))/y;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type MarkedEditorFactory = EditorFactory & { [EDITOR_FACTORY_MARK]?: true };
type RenderFn = (width: number) => string[];
type UserMessageTransform = (lines: string[]) => string[];

interface UserMessageTransformRegistry {
  version: 1;
  transforms: Map<symbol, UserMessageTransform>;
  hostOwner?: symbol;
}

interface PresentationState {
  owner?: object;
  knownNames: ReadonlySet<string>;
  getTheme?: () => Theme;
  decoratedEditors: WeakSet<object>;
}

interface FallbackPatchState {
  original: RenderFn;
  patched: RenderFn;
  owners: Set<object>;
}

interface ChipTheme {
  fg(token: "accent" | "text", text: string): string;
  bg(token: "selectedBg", text: string): string;
}

interface VisualSkillMention extends SkillMention {
  chip: string;
}

function presentationState(): PresentationState {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const current = scope[PRESENTATION_STATE_KEY];
  if (typeof current === "object" && current !== null) return current as PresentationState;
  const created: PresentationState = {
    knownNames: new Set(),
    decoratedEditors: new WeakSet(),
  };
  scope[PRESENTATION_STATE_KEY] = created;
  return created;
}

function userMessageTransforms(create: boolean): UserMessageTransformRegistry | undefined {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const current = scope[USER_MESSAGE_TRANSFORMS_KEY];
  if (current === undefined && create) {
    const created: UserMessageTransformRegistry = { version: 1, transforms: new Map() };
    scope[USER_MESSAGE_TRANSFORMS_KEY] = created;
    return created;
  }
  if (
    typeof current !== "object"
    || current === null
    || (current as { version?: unknown }).version !== 1
    || !((current as { transforms?: unknown }).transforms instanceof Map)
  ) {
    return undefined;
  }
  return current as UserMessageTransformRegistry;
}

function applyUserMessageTransforms(lines: string[]): string[] {
  const registry = userMessageTransforms(false);
  if (!registry) return lines;
  let output = lines;
  for (const transform of [...registry.transforms.values()]) {
    try {
      const transformed = transform(output);
      if (Array.isArray(transformed) && transformed.every((line) => typeof line === "string")) {
        output = transformed;
      }
    } catch {
      // Presentation transforms are cosmetic and fail open independently.
    }
  }
  return output;
}

function splitControls(line: string): { plain: string; controls: string[][] } {
  let plain = "";
  const controls: string[][] = [[]];
  for (let index = 0; index < line.length;) {
    ANSI_OR_CONTROL_RE.lastIndex = index;
    const control = ANSI_OR_CONTROL_RE.exec(line);
    if (control) {
      controls[plain.length]!.push(control[0]);
      index += control[0].length;
      continue;
    }
    plain += line[index];
    controls.push([]);
    index++;
  }
  return { plain, controls };
}

function visualSkillMentions(text: string, knownNames: ReadonlySet<string>): VisualSkillMention[] {
  const mentions: VisualSkillMention[] = findSkillMentions(text)
    .filter((mention) => knownNames.has(mention.name))
    .map((mention) => ({ ...mention, chip: `✦${mention.name}` }));
  const firstContent = text.search(/\S/);
  if (firstContent >= 0) {
    const invocation = parseSkillCommandInvocation(text.slice(firstContent));
    if (invocation && knownNames.has(invocation.name)) {
      mentions.push({
        start: firstContent,
        end: firstContent + 7 + invocation.name.length,
        name: invocation.name,
        chip: `✦skill:${invocation.name}`,
      });
    }
  }
  return mentions.sort((left, right) => left.start - right.start);
}

/** Replace known `$name` and leading `/skill:name` tokens with equal-width chips. */
export function decorateSkillMentions(
  line: string,
  knownNames: ReadonlySet<string>,
  theme: ChipTheme,
): string {
  const { plain, controls } = splitControls(line);
  const matches = visualSkillMentions(plain, knownNames);
  if (matches.length === 0) return line;
  const byStart = new Map(matches.map((mention) => [mention.start, mention]));
  let output = "";
  for (let index = 0; index < plain.length;) {
    const mention = byStart.get(index);
    if (!mention) {
      output += controls[index]!.join("") + plain[index];
      index++;
      continue;
    }
    const chip = mention.chip;
    for (let chipIndex = 0; chipIndex < chip.length; chipIndex++) {
      output += controls[index + chipIndex]!.join("");
      output += theme.bg(
        "selectedBg",
        theme.fg(chipIndex === 0 ? "accent" : "text", chip[chipIndex]!),
      );
    }
    index = mention.end;
  }
  return output + controls[plain.length]!.join("");
}

export function decorateSkillMentionLines(
  lines: readonly string[],
  knownNames: ReadonlySet<string>,
  theme: ChipTheme,
): string[] {
  return lines.map((line) => decorateSkillMentions(line, knownNames, theme));
}

function decorateCurrentSkillMentions(lines: string[]): string[] {
  const state = presentationState();
  const theme = state.getTheme?.();
  return theme && state.knownNames.size > 0
    ? decorateSkillMentionLines(lines, state.knownNames, theme)
    : lines;
}

function decorateEditor(editor: EditorComponent): EditorComponent {
  const state = presentationState();
  const candidate = editor as EditorComponent & { render: RenderFn };
  if (state.decoratedEditors.has(candidate)) return editor;
  const original = candidate.render.bind(candidate);
  candidate.render = (width: number) => decorateCurrentSkillMentions(original(width));
  state.decoratedEditors.add(candidate);
  return editor;
}

/**
 * Preserve the exact editor instance so private autocomplete fields and child
 * discovery remain visible to fullscreen and other UI integrations.
 */
export function wrapEditorFactory(factory: EditorFactory | undefined): EditorFactory {
  if ((factory as MarkedEditorFactory | undefined)?.[EDITOR_FACTORY_MARK]) return factory!;
  const wrapped: MarkedEditorFactory = (tui, theme, keybindings) => decorateEditor(
    factory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings),
  );
  Object.defineProperty(wrapped, EDITOR_FACTORY_MARK, { value: true });
  return wrapped;
}

function installFallbackUserMessageHost(owner: object): void {
  const registry = userMessageTransforms(true);
  if (!registry) return;
  const prototype = UserMessageComponent.prototype as unknown as Record<PropertyKey, unknown> & {
    render: RenderFn;
  };
  const existing = prototype[FALLBACK_USER_MESSAGE_PATCH] as FallbackPatchState | undefined;
  if (registry.hostOwner === FALLBACK_USER_MESSAGE_HOST && existing) {
    existing.owners.add(owner);
    return;
  }
  if (registry.hostOwner !== undefined) return;

  // Pi 1.5 exposes this class, but replacing its prototype method is private.
  // Match scripts/probe.ts: without a writable data method, leave native rendering alone.
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (typeof descriptor?.value !== "function" || descriptor.writable !== true) return;
  const original = descriptor.value as RenderFn;
  const patched: RenderFn = function (this: unknown, width: number): string[] {
    return applyUserMessageTransforms(original.call(this, width));
  };
  prototype.render = patched;
  prototype[FALLBACK_USER_MESSAGE_PATCH] = {
    original,
    patched,
    owners: new Set([owner]),
  } satisfies FallbackPatchState;
  registry.hostOwner = FALLBACK_USER_MESSAGE_HOST;
}

function uninstallFallbackUserMessageHost(owner: object): void {
  const registry = userMessageTransforms(false);
  const prototype = UserMessageComponent.prototype as unknown as Record<PropertyKey, unknown> & {
    render: RenderFn;
  };
  const patch = prototype[FALLBACK_USER_MESSAGE_PATCH] as FallbackPatchState | undefined;
  if (!patch) return;
  patch.owners.delete(owner);
  if (patch.owners.size > 0) return;
  if (prototype.render === patch.patched) prototype.render = patch.original;
  delete prototype[FALLBACK_USER_MESSAGE_PATCH];
  if (registry?.hostOwner === FALLBACK_USER_MESSAGE_HOST) delete registry.hostOwner;
}

export class SkillPresentation {
  private readonly owner = {};
  private readonly transform: UserMessageTransform = (lines) => decorateCurrentSkillMentions(lines);

  activate(ctx: ExtensionContext, catalog: readonly SkillRef[]): void {
    const state = presentationState();
    state.owner = this.owner;
    state.getTheme = () => ctx.ui.theme;
    this.updateCatalog(catalog);
    const registry = userMessageTransforms(true);
    registry?.transforms.set(USER_MESSAGE_TRANSFORM_ID, this.transform);
    if (ctx.mode === "tui") {
      this.ensureEditor(ctx);
      installFallbackUserMessageHost(this.owner);
    }
  }

  updateCatalog(catalog: readonly SkillRef[]): void {
    const state = presentationState();
    if (state.owner === this.owner) {
      state.knownNames = new Set(catalog.map((skill) => skill.name));
    }
  }

  ensureEditor(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      const current = ctx.ui.getEditorComponent();
      if ((current as MarkedEditorFactory | undefined)?.[EDITOR_FACTORY_MARK]) return;
      ctx.ui.setEditorComponent(wrapEditorFactory(current));
    } catch {
      // The editor may belong to a stale session; visual decoration fails open.
    }
  }

  deactivate(): void {
    const registry = userMessageTransforms(false);
    if (registry?.transforms.get(USER_MESSAGE_TRANSFORM_ID) === this.transform) {
      registry.transforms.delete(USER_MESSAGE_TRANSFORM_ID);
    }
    uninstallFallbackUserMessageHost(this.owner);
    const state = presentationState();
    if (state.owner === this.owner) {
      state.owner = undefined;
      state.knownNames = new Set();
      state.getTheme = undefined;
    }
  }
}
