export type MailboxInjectionTargetV1 = { readonly kind: "task"; readonly taskId: string } | { readonly kind: "idle-conversation" };
export interface MailboxDeliveryItemV1 { readonly messageId: string; readonly body: string; readonly bodySha256: string; readonly injectedInto: MailboxInjectionTargetV1; readonly source?: string }
export type MailboxDeliveryProofV1 =
  | { readonly messageId: string; readonly bodySha256: string; readonly injectedInto: MailboxInjectionTargetV1; readonly state: "injected"; readonly entryId: string }
  | { readonly messageId: string; readonly bodySha256: string; readonly injectedInto: MailboxInjectionTargetV1; readonly state: "pending" };
