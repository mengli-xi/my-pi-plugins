/** Startup entry: no schema, commands, proof, storage or delivery engine imports. */
export type * from "./types.js";
export * from "./constants.js";
export { MailboxError } from "./errors.js";
export { bindMailbox } from "./runtime.js";

/** On-demand read-only projection; importing light never loads proof/schema/engine/storage. */
export async function filterMailboxMessages(
  ctx: Pick<import("@earendil-works/pi-coding-agent").ExtensionContext, "sessionManager" | "cwd">,
  messages: readonly import("@earendil-works/pi-coding-agent").ContextEvent["messages"][number][],
  options?: import("./types.js").BindMailboxOptions,
): Promise<import("@earendil-works/pi-coding-agent").ContextEvent["messages"]> {
  // Only native custom carriers can match mailbox bodies.
  if (!messages.some(message => message.role === "custom")) return [...messages];
  return (await import("./projection.js")).filterMailboxMessages(ctx, messages, options);
}
