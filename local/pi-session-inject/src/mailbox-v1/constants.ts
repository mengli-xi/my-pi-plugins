export const MAILBOX_ABI_VERSION = 1 as const;
export const MAILBOX_TRANSPORT_BUILD_ID = "mailbox-v1.0.6" as const;
export const MAILBOX_HOLDER_KEY = "pi.session-inject.mailbox.v1" as const;
export const MAILBOX_POLICIES = ["next-request", "next-user", "new-run"] as const;
export const MAILBOX_COMMANDS = ["status", "resume", "recover"] as const;
export const MAILBOX_CUSTOM_TYPES = {
  trigger: "agent-mailbox-trigger-v1",
  attempt: "agent-mailbox-attempt-v1",
  delivery: "agent-mailbox-delivery-v1",
} as const;
export const MAILBOX_COMMAND_DESCRIPTION =
  "Mailbox status | resume | recover <session-id>; resume releases current transport hold, not business restrictions";
