import { convertToLlm, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ContentPart { partIndex: number; role: string; kind: string; text?: string; toolCall?: { id: string; name: string; arguments: unknown }; media?: { mimeType: string; encodedBytes: number } }
/** Pi owns visibility and conversion. Derived entries use the public projected part index. */
export function contentParts(entry: SessionEntry, messages = sessionEntryToContextMessages(entry)): ContentPart[] {
  return convertToLlm(messages).flatMap((message) => {
    if (message.role === "system") return [];
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return content.flatMap((part, partIndex): ContentPart[] => {
      const base = { partIndex, role: message.role };
      if (part.type === "text") return [{ ...base, kind: "text", text: part.text }];
      if (part.type === "toolCall") return [{ ...base, kind: "toolCall", toolCall: part, text: JSON.stringify({ toolCallId: part.id, name: part.name, arguments: part.arguments }) }];
      if (part.type === "image") return [{ ...base, kind: "image", media: { mimeType: part.mimeType, encodedBytes: Buffer.byteLength(part.data) } }];
      return []; // Hidden reasoning is not a source quotation or retrieval target.
    });
  });
}
export function textParts(entry: SessionEntry): Array<{ partIndex: number; text: string }> {
  return contentParts(entry).flatMap(p => p.kind === "text" ? [{ partIndex: p.partIndex, text: p.text! }] : []);
}
export function editedEntryIds(branch: SessionEntry[]): Set<string> {
  return new Set(branch.flatMap(entry => entry.type === "context_edit" ? [entry.targetId] : []));
}
