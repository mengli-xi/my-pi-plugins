import type { Message } from "@earendil-works/pi-ai";

// Magic Context 0.41.1's Pi m[0]/m[1] envelope and additive text decorations.
// Legacy read compatibility only, not a producer dependency or generic XML/tag
// sanitizer. Self-contained format fixtures cover known shapes; unknown shapes stay unmappable.
const M0_BLOCKS = ["project-docs", "user-profile", "session-history", "project-memory", "memory-mural"];
const M1_BLOCKS = ["memory-updates", "new-compartments", "new-memories", "new-user-profile"];
const M1_EMPTY = "<session-history-since>(no new content since last materialization)</session-history-since>";
const TAG = /^§[1-9]\d*§ /u;
const TEMPORAL = /^<!-- \+(?:[5-9]m|[1-5]\dm|(?:[1-9]|1\d|2[0-3])h(?: (?:[1-9]|[1-5]\d)m)?|[1-6]d(?: (?:[1-9]|1\d|2[0-3])h)?|[1-9]\d*w(?: [1-6]d)?) -->\n/u;

function blocks(text: string, names: readonly string[], separator: string): boolean {
  let rest = text;
  for (const name of names) {
    const open = `<${name}>`, close = `</${name}>`;
    if (!rest.startsWith(open)) continue;
    const end = rest.indexOf(close, open.length);
    if (end < 0) return false;
    rest = rest.slice(end + close.length);
    if (!rest) return true;
    if (!rest.startsWith(separator)) return false;
    rest = rest.slice(separator.length);
    if (!rest) return false;
  }
  return rest.length === 0;
}
function onlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function injectedUser(message: Message | undefined): message is Extract<Message, { role: "user" }> {
  return !!message && message.role === "user" && onlyKeys(message, ["role", "content", "timestamp"]) && Array.isArray(message.content);
}

/** The pair is leading, untagged, ordered and timestamped relative to its body. */
export function magicContextPreambleIndices(messages: readonly Message[]): number[] {
  const first = messages.findIndex(message => message.role !== "system");
  if (first < 0) return [];
  const m0 = messages[first], m1 = messages[first + 1], body = messages[first + 2];
  if (!injectedUser(m0) || !injectedUser(m1) || !body ||
      m0.timestamp !== body.timestamp - 2 || m1.timestamp !== body.timestamp - 1) return [];
  const c0 = m0.content, c1 = m1.content;
  if (!Array.isArray(c0) || !Array.isArray(c1) || c0.length < 1 || c0.length > 2 || c1.length !== 1) return [];
  const t0 = c0[0], t1 = c1[0];
  if (t0?.type !== "text" || t1?.type !== "text" || !onlyKeys(t0, ["type", "text"]) || !onlyKeys(t1, ["type", "text"]) || !blocks(t0.text, M0_BLOCKS, "\n\n")) return [];
  if (c0.length === 2 && (c0[1]?.type !== "image" || !onlyKeys(c0[1], ["type", "data", "mimeType"]) ||
      !t0.text.endsWith("<memory-mural>\nThe project memory mural image follows.\n</memory-mural>"))) return [];
  if (t1.text !== M1_EMPTY) {
    const match = /^(?:<session-history-since>\n([\s\S]*)\n<\/session-history-since>|<knowledge-updates>\n([\s\S]*)\n<\/knowledge-updates>)$/u.exec(t1.text);
    const body = match?.[1] ?? match?.[2];
    if (!body || !blocks(body, M1_BLOCKS, "\n")) return [];
  }
  return [first, first + 1];
}

/** Pre-existing native tags make MC's prefix replacement non-injective. */
export function magicContextHasLossyNativePrefix(message: Message): boolean {
  if (message.role !== "user") return false;
  // prependTag first removes existing well-formed, malformed and dangling tags.
  // Conservatively reject their whole leading §+digit family rather than trying
  // to invert a non-injective rewrite or trusting a coincidentally exact match.
  return typeof message.content === "string" ? /^§\d/u.test(message.content)
    : message.content.some(part => part.type === "text" && /^§\d/u.test(part.text));
}

/** Only safe after the native-prefix ambiguity check, including preamble/body. */
export function magicContextUserIdentities(message: Message): Message[] {
  if (message.role !== "user") return [message];
  const variants: Message[] = [message];
  for (const tags of [false, true]) for (const temporal of [false, true]) {
    if (!tags && !temporal) continue;
    let firstText = true;
    const clean = (text: string): string => {
      let result = tags ? text.replace(TAG, "") : text;
      if (firstText && temporal) result = result.replace(TEMPORAL, "");
      firstText = false;
      return result;
    };
    const content = typeof message.content === "string" ? clean(message.content) : message.content.map(part => part.type === "text" ? { ...part, text: clean(part.text) } : part);
    variants.push({ ...message, content });
  }
  return variants;
}
