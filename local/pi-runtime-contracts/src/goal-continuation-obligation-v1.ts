/** Goal owns durable intent; producers only ask whether fallback wake is safe. */
export type GoalContinuationObligationV1 = "owed" | "none" | "unknown";
export interface GoalContinuationQueryV1 {
  readonly sessionId: string;
  readonly continuationId: string;
}
export const GOAL_CONTINUATION_OBLIGATION_V1_SYMBOL = Symbol.for(
  "pi.goal.continuation-obligation.v1",
);
type Reader = (query: GoalContinuationQueryV1) => GoalContinuationObligationV1;
interface Holder {
  readonly version: 1;
  query(query: GoalContinuationQueryV1): GoalContinuationObligationV1;
  register(reader: Reader): { dispose(): void };
}
function compatible(value: unknown): value is Holder {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Holder>;
  return candidate.version === 1 && typeof candidate.query === "function" &&
    typeof candidate.register === "function";
}
function existing() {
  return Object.getOwnPropertyDescriptor(globalThis, GOAL_CONTINUATION_OBLIGATION_V1_SYMBOL);
}
export function queryGoalContinuationObligationV1(
  query: GoalContinuationQueryV1,
): GoalContinuationObligationV1 {
  const holder = existing();
  if (!holder) return "none";
  if (!compatible(holder.value)) return "unknown";
  try {
    const result = holder.value.query(query);
    return result === "owed" || result === "none" ? result : "unknown";
  } catch { return "unknown"; }
}
export function registerGoalContinuationObligationV1(reader: Reader): { dispose(): void } {
  let holder = existing()?.value;
  if (existing() && !compatible(holder)) throw new Error("Incompatible Goal obligation holder");
  if (!holder) {
    const readers = new Map<symbol, Reader>();
    holder = Object.freeze({
      version: 1 as const,
      query(query: GoalContinuationQueryV1) {
        let unknown = false;
        for (const current of readers.values()) {
          try {
            const result = current(query);
            if (result === "owed") return "owed";
            if (result !== "none") unknown = true;
          } catch { unknown = true; }
        }
        return unknown ? "unknown" : "none";
      },
      register(current: Reader) {
        const token = Symbol();
        readers.set(token, current);
        return { dispose() { readers.delete(token); } };
      },
    } satisfies Holder);
    Object.defineProperty(globalThis, GOAL_CONTINUATION_OBLIGATION_V1_SYMBOL, {
      value: holder, writable: false, configurable: false, enumerable: false,
    });
  }
  return (holder as Holder).register(reader);
}
