import type { ProcessWaitAdmissionV2 } from "pi-runtime-contracts/process-wait-bridge-v2";

export async function admitOwnedProcessContinuationV2(input: {
  readonly ownerToken: string;
  captureCurrentOwnerToken(): string;
  admit(): Promise<ProcessWaitAdmissionV2>;
}): Promise<ProcessWaitAdmissionV2> {
  let currentOwnerToken: string;
  try {
    currentOwnerToken = input.captureCurrentOwnerToken();
  } catch {
    return "record-only";
  }
  if (!input.ownerToken || input.ownerToken !== currentOwnerToken) return "record-only";
  return input.admit();
}
