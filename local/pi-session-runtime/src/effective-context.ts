import { createHash } from "node:crypto";
import { magicContextHasLossyNativePrefix, magicContextPreambleIndices, magicContextUserIdentities } from "#internal/magic-context-format";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry, SourceInfo } from "@earendil-works/pi-coding-agent";

type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
export interface ModelRef { provider: string; id: string }
export interface ContextIdentity {
  sessionId: string;
  generation: number;
  selectedModel: ModelRef;
  thinkingLevel: string;
  toolLoadoutFingerprint: string;
  capabilityFingerprint: string;
}
export interface TurnAnchor { entryId: string; messageIndex: number }
export interface NativeMessageOrigin {
  message: Message;
  kind: "turn" | "preamble" | "body" | "unknown";
  /** Native business input, including bash/custom input; never a synthetic summary. */
  turnId?: string;
}
export interface EffectiveCapture extends ContextIdentity {
  requestOrdinal: number;
  leafId: string | null;
  physicalModel: ModelRef;
  normalizedMessages: Message[];
  contextCandidateHash: string;
  normalizedRequestHash: string;
  capturedAt: number;
  turnAnchors: TurnAnchor[];
  preambleMessageIndices: number[];
  attachedMessageIndices: number[];
  turnMappingReliable: boolean;
  /** Reserved for provider-specific wire reconciliation; normalized capture is not wire proof. */
  wirePrefix: "unknown";
}
export function contextFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** In-memory only. Invalidating a session also fences candidates not yet sent to a provider. */
export class EffectiveContextStore {
  #partitions = new Map<string, { generation: number; revision: number; capture?: EffectiveCapture; reason?: string; nativeMessages?: Message[]; transform?: "native-only" | "transformed" }>();
  bind(sessionId: string, generation: number): void {
    if (this.#partitions.get(sessionId)?.generation !== generation) this.#partitions.set(sessionId, { generation, revision: 0 });
  }
  revision(sessionId: string): number { return this.#partitions.get(sessionId)?.revision ?? -1; }
  put(capture: EffectiveCapture, revision: number, origins: readonly NativeMessageOrigin[]): boolean {
    const partition = this.#partitions.get(capture.sessionId);
    if (!partition || partition.generation !== capture.generation || partition.revision !== revision) return false;
    const copiedCapture = structuredClone(capture);
    const nativeMessages = structuredClone(origins.map((origin) => origin.message));
    partition.capture = copiedCapture;
    partition.nativeMessages = nativeMessages;
    partition.transform = undefined;
    partition.reason = undefined;
    return true;
  }
  get(sessionId: string, generation: number): EffectiveCapture | undefined {
    const partition = this.#partitions.get(sessionId);
    return partition?.generation === generation && partition.capture ? structuredClone(partition.capture) : undefined;
  }
  invalidate(sessionId: string, reason: string): void {
    const partition = this.#partitions.get(sessionId);
    if (partition) {
      partition.capture = undefined; partition.nativeMessages = undefined; partition.transform = undefined;
      partition.reason = reason; partition.revision++;
    }
  }
  reason(sessionId: string): string { return this.#partitions.get(sessionId)?.reason ?? "no-capture"; }
  requestTransforms(sessionId: string, generation: number, capabilityFingerprint: string): "native-only" | "transformed" | "unknown" {
    const partition = this.#partitions.get(sessionId);
    if (!partition?.capture || !partition.nativeMessages || partition.generation !== generation || partition.capture.capabilityFingerprint !== capabilityFingerprint) return "unknown";
    // Validate only when a consumer asks to fork. The memo belongs to this exact capture,
    // never to the whole generation: later requests and structural resets discard it.
    return partition.transform ??= contextFingerprint(partition.nativeMessages) === partition.capture.normalizedRequestHash ? "native-only" : "transformed";
  }
  release(sessionId: string, generation: number): void {
    if (this.#partitions.get(sessionId)?.generation === generation) this.#partitions.delete(sessionId);
  }
}

export interface RequestCandidate extends Omit<ContextIdentity, "sessionId" | "generation"> {
  leafId: string | null;
  /** Main agent run signal, never a summary/warming request's independent signal. */
  signal: AbortSignal;
  auxiliaryMessages: readonly unknown[];
  nativeOrigins: readonly NativeMessageOrigin[];
  /** Explicitly identified persistent preambles, not arbitrary custom or bash messages. */
  knownPreamble: readonly Message[];
}
interface Candidate extends Omit<RequestCandidate, "auxiliaryMessages"> { ordinal: number; hash: string; revision: number; consumed: boolean; observers: Set<symbol> }
interface Binding {
  sessionId: string; generation: number; identity: object;
  owners: Map<symbol, string>; providers: Set<Provider>; candidate?: Candidate; ordinal: number;
}
interface Decoration { original: Provider["streamSimple"]; wrapper: Provider["streamSimple"]; bindings: Set<Binding> }
interface ProviderInvocation { binding: Binding; candidate: Candidate; physicalModel: ModelRef; messages: Message[] }
function restoreProvider(provider: Provider, decoration: Decoration): void {
  if (provider.streamSimple !== decoration.wrapper) return;
  try { provider.streamSimple = decoration.original; } catch { /* Provider became read-only; the retired wrapper only forwards. */ }
}
interface ProcessCell {
  store: EffectiveContextStore; nextGeneration: number;
  bindings: Map<string, Binding>; providers: WeakMap<Provider, Decoration>;
  invocations: AsyncLocalStorage<ProviderInvocation[]>;
}
const CELL = Symbol.for("pi.session-runtime.effective-context.v1");
function cell(): ProcessCell {
  const processState = globalThis as typeof globalThis & { [CELL]?: ProcessCell };
  return processState[CELL] ??= { store: new EffectiveContextStore(), nextGeneration: 0, bindings: new Map(), providers: new WeakMap(), invocations: new AsyncLocalStorage() };
}
export function getEffectiveContextStore(): EffectiveContextStore { return cell().store; }
export function getEffectiveContextGeneration(sessionId: string): number | undefined { return cell().bindings.get(sessionId)?.generation; }

/** Exact identities plus the bounded Magic Context format; ambiguity refuses numeric N. */
export function mapEffectiveTurns(messages: readonly Message[], origins: readonly NativeMessageOrigin[], knownPreamble: readonly Message[] = []): Pick<EffectiveCapture, "turnAnchors" | "preambleMessageIndices" | "attachedMessageIndices" | "turnMappingReliable"> {
  const nativeUsers = origins.filter((origin) => origin.message.role === "user");
  const byHash = new Map<string, Array<{ origin: NativeMessageOrigin; index: number }>>();
  for (const [index, origin] of nativeUsers.entries()) {
    const hash = contextFingerprint(origin.message);
    const matches = byHash.get(hash) ?? []; matches.push({ origin, index }); byHash.set(hash, matches);
  }
  const preambles = new Set(knownPreamble.filter((message) => message.role === "user").map(contextFingerprint));
  const magicPreamble = new Set(magicContextPreambleIndices(messages));
  if (magicPreamble.size && nativeUsers.some(({ message }) => magicContextHasLossyNativePrefix(message))) {
    // Do not label a lossy turn rewrite as another turn, attached body or preamble.
    return { turnAnchors: [], preambleMessageIndices: messages.flatMap((message, index) => message.role === "system" ? [index] : []), attachedMessageIndices: [], turnMappingReliable: false };
  }
  const anchors: TurnAnchor[] = [];
  const preambleMessageIndices: number[] = [];
  const attachedMessageIndices: number[] = [];
  let reliable = true;
  const used = new Set<string>();
  let lastNativeIndex = -1;
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "system") { preambleMessageIndices.push(messageIndex); continue; }
    if (message.role !== "user") continue;
    const digest = contextFingerprint(message);
    const identities = magicPreamble.size ? magicContextUserIdentities(message) : [message];
    const matches = [...new Map(identities.flatMap(identity => byHash.get(contextFingerprint(identity)) ?? []).map(match => [match.index, match])).values()];
    if (magicPreamble.size && matches.length > 1) { reliable = false; continue; }
    if (magicPreamble.has(messageIndex)) {
      // A native turn colliding with the synthetic envelope is not provenance.
      if (matches.every(({ origin }) => origin.kind === "preamble")) preambleMessageIndices.push(messageIndex);
      else reliable = false;
      continue;
    }
    if (matches.length === 1 && matches[0]!.origin.kind === "turn" && matches[0]!.origin.turnId && !used.has(matches[0]!.origin.turnId!) && matches[0]!.index > lastNativeIndex) {
      const { origin, index } = matches[0]!;
      used.add(origin.turnId!); lastNativeIndex = index;
      anchors.push({ entryId: origin.turnId!, messageIndex });
    } else if (matches.length > 0 && matches.every(({ origin }) => origin.kind === "preamble")) preambleMessageIndices.push(messageIndex);
    else if (matches.length === 1 && matches[0]!.origin.kind === "body") attachedMessageIndices.push(messageIndex);
    else if (matches.length === 0 && preambles.has(digest)) preambleMessageIndices.push(messageIndex);
    else reliable = false;
  }
  return { turnAnchors: anchors, preambleMessageIndices, attachedMessageIndices, turnMappingReliable: reliable };
}

function decorate(provider: Provider, binding: Binding): boolean {
  const state = cell();
  let decoration = state.providers.get(provider);
  if (decoration && provider.streamSimple !== decoration.wrapper) {
    // A later owner replaced the public function. Retire our old observer before wrapping it.
    for (const attached of decoration.bindings) attached.providers.delete(provider);
    decoration.bindings.clear(); decoration = undefined;
  }
  if (!decoration) {
    const original = provider.streamSimple;
    const bindings = new Set<Binding>();
    const wrapper: Provider["streamSimple"] = function(this: Provider, model, context, options) {
      // An external decorator may retain this wrapper after it is retired. Forward
      // without masking the invocation established by its active outer replacement.
      if (bindings.size === 0) return original.call(this, model, context, options);
      const invocations: ProviderInvocation[] = [];
      for (const active of bindings) {
        const candidate = active.candidate;
        if (state.bindings.get(active.sessionId) !== active || !candidate || candidate.consumed || candidate.signal.aborted ||
            options?.sessionId !== active.sessionId || options.signal !== candidate.signal) continue;
        try {
          invocations.push({ binding: active, candidate, physicalModel: { provider: model.provider, id: model.id }, messages: structuredClone(context.messages) });
        } catch { /* An unconfirmed direct request must not invalidate Main's capture. */ }
      }
      // Preserve the original receiver, exact options (including callbacks), stream and thrown errors.
      // A native Pi provider hook confirms ownership inside this async invocation. Merely
      // sharing session/signal/anchor (e.g. a summary) cannot consume the business candidate.
      return state.invocations.run(invocations, () => original.call(this, model, context, options));
    };
    try { provider.streamSimple = wrapper; } catch { return false; }
    if (provider.streamSimple !== wrapper) return false;
    decoration = { original, wrapper, bindings };
    state.providers.set(provider, decoration);
  }
  decoration.bindings.add(binding); binding.providers.add(provider);
  return true;
}
function detach(binding: Binding): void {
  const state = cell();
  for (const provider of binding.providers) {
    const decoration = state.providers.get(provider);
    if (!decoration) continue;
    decoration.bindings.delete(binding);
    if (decoration.bindings.size === 0) {
      restoreProvider(provider, decoration);
      state.providers.delete(provider);
    }
  }
  binding.providers.clear(); binding.candidate = undefined;
  state.store.release(binding.sessionId, binding.generation);
}

export interface EffectiveCaptureLease {
  readonly generation: number;
  observe(candidate: RequestCandidate): void;
  refreshProviders(registry: Pick<ExtensionContext["modelRegistry"], "getRegisteredProviderIds" | "getAll" | "getProvider">): boolean;
  /** Call only from Pi's native before_provider_request / after_provider_response hook. */
  confirmRequest(signal: AbortSignal | undefined): void;
  endRequest(): void;
  /** Main binding shutdown/reload retires this generation even if another consumer still holds a lease. */
  retire(): void;
  release(): void;
}
/** Consumers sharing the public SessionManager identity share one generation and decorator. */
export function acquireEffectiveCapture(input: { owner: string; sessionId: string; binding: object }): EffectiveCaptureLease {
  const state = cell();
  let binding = state.bindings.get(input.sessionId);
  if (binding && binding.identity !== input.binding) { detach(binding); state.bindings.delete(input.sessionId); binding = undefined; }
  if (!binding) {
    binding = { sessionId: input.sessionId, generation: ++state.nextGeneration, identity: input.binding, owners: new Map(), providers: new Set(), ordinal: 0 };
    state.bindings.set(input.sessionId, binding); state.store.bind(input.sessionId, binding.generation);
  }
  const current = binding;
  const token = Symbol(input.owner); current.owners.set(token, input.owner);
  const active = () => state.bindings.get(input.sessionId) === current && current.owners.has(token);
  return {
    generation: current.generation,
    observe(candidate) {
      if (!active()) return;
      const hash = contextFingerprint(candidate.auxiliaryMessages);
      const prior = current.candidate;
      if (prior?.signal === candidate.signal && prior.leafId === candidate.leafId && prior.hash === hash && prior.revision === state.store.revision(input.sessionId) && !prior.observers.has(token)) { prior.observers.add(token); return; }
      // Once a new business request is prepared, an unobserved provider call may have a
      // different projection. Never serve an older request as the current tool turn's capture.
      state.store.invalidate(input.sessionId, "awaiting-provider-capture");
      const { auxiliaryMessages: _auxiliary, ...snapshot } = candidate;
      current.candidate = { ...snapshot, nativeOrigins: structuredClone(candidate.nativeOrigins), knownPreamble: structuredClone(candidate.knownPreamble), ordinal: ++current.ordinal, hash, revision: state.store.revision(input.sessionId), consumed: false, observers: new Set([token]) };
    },
    confirmRequest(signal) {
      if (!active() || !signal || signal.aborted) return;
      const invocation = state.invocations.getStore()?.find((item) => item.binding === current && item.candidate === current.candidate && item.candidate.signal === signal);
      if (!invocation || invocation.candidate.consumed || invocation.candidate.revision !== state.store.revision(input.sessionId)) return;
      const { candidate, physicalModel, messages } = invocation;
      candidate.consumed = true;
      try {
        const normalizedRequestHash = contextFingerprint(messages);
        const capture: EffectiveCapture = {
          sessionId: current.sessionId, generation: current.generation, requestOrdinal: candidate.ordinal,
          leafId: candidate.leafId,
          selectedModel: { ...candidate.selectedModel }, physicalModel,
          thinkingLevel: candidate.thinkingLevel, toolLoadoutFingerprint: candidate.toolLoadoutFingerprint,
          capabilityFingerprint: candidate.capabilityFingerprint, normalizedMessages: messages,
          contextCandidateHash: candidate.hash, normalizedRequestHash, capturedAt: Date.now(), wirePrefix: "unknown",
          ...mapEffectiveTurns(messages, candidate.nativeOrigins, candidate.knownPreamble),
        };
        state.store.put(capture, candidate.revision, candidate.nativeOrigins);
      } catch { state.store.invalidate(input.sessionId, "capture-copy-failed"); }
    },
    refreshProviders(registry) {
      if (!active()) return false;
      // getRegisteredProviderIds covers extensions only; built-in and routed physical providers
      // come from the public model catalog as well.
      const ids = new Set([...registry.getRegisteredProviderIds(), ...registry.getAll().map((model) => model.provider)]);
      const live = new Set([...ids].map((id) => registry.getProvider(id)).filter((provider): provider is Provider => !!provider));
      let wrapped = true;
      for (const provider of live) if (!decorate(provider, current)) wrapped = false;
      // Stale provider objects must not consume a candidate for a newly registered provider.
      for (const provider of current.providers) if (!live.has(provider)) {
        const decoration = state.providers.get(provider);
        decoration?.bindings.delete(current); current.providers.delete(provider);
        if (decoration?.bindings.size === 0) {
          restoreProvider(provider, decoration);
          state.providers.delete(provider);
        }
      }
      if (!wrapped) state.store.invalidate(input.sessionId, "provider-not-decoratable");
      return wrapped;
    },
    endRequest() { if (active()) current.candidate = undefined; },
    retire() {
      if (!active()) return;
      detach(current); state.bindings.delete(input.sessionId);
    },
    release() {
      if (!active()) return;
      current.owners.delete(token);
      if (current.owners.size === 0) { detach(current); state.bindings.delete(input.sessionId); }
    },
  };
}

/** Uses package metadata at the canonical public source path, never command-name heuristics. */
export function canonicalSourcePackage(source: SourceInfo): string | undefined {
  if (source.source === "builtin" || source.path.startsWith("<")) return undefined;
  const path = isAbsolute(source.path) ? source.path : source.baseDir ? resolve(source.baseDir, source.path) : undefined;
  if (!path) return undefined;
  try {
    let directory = dirname(realpathSync(path));
    while (true) {
      try { const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")); if (typeof manifest.name === "string") return manifest.name; } catch {}
      const parent = dirname(directory); if (parent === directory) return undefined; directory = parent;
    }
  } catch { return undefined; }
}
export function requiresEffectiveCapture(input: {
  branch: readonly SessionEntry[];
  sources?: readonly SourceInfo[];
  requestTransforms: "native-only" | "transformed" | "unknown";
}): boolean {
  return input.requestTransforms !== "native-only" ||
    input.sources?.some((source) => ["@cortexkit/pi-magic-context", "pi-magic-context"].includes(canonicalSourcePackage(source) ?? "")) === true ||
    input.branch.some((entry) => entry.type === "compaction" && (entry.details as { source?: unknown } | undefined)?.source === "magic-context");
}
