import { getContinuationRegistryV1 } from "pi-runtime-contracts/continuation-v1";

/** 协议对端：只 claim 并返回指定形状的 receipt，不实现 Goal 排程/存储/命令。 */
export function wakePeer(sessionId: string, receipt: { scheduling?: "scheduled" | "coalesced"; continuationId?: string } = {}) {
  let receipts = 0;
  // 兼容已持久化 receipt 的公开 consumer token，不加载 Goal 实现。
  const registered = getContinuationRegistryV1().registerWakeConsumer({
    sessionId, consumerId: "pi-goal-local",
    onOffer(_offer, claim) {
      const handle = claim();
      if (!handle.ok) throw new Error(handle.message);
      const result = handle.value.onSettledWithReceipt(() => {
        receipts++;
        return {
          version: 1, ...handle.value.consumerIdentity(),
          continuationId: receipt.continuationId ?? `fixture-receipt-${receipts}`,
          scheduling: receipt.scheduling ?? "scheduled",
        };
      });
      if (!result.ok) throw new Error(result.message);
    },
  });
  if (!registered.ok) throw new Error(registered.message);
  return { dispose: () => registered.value.dispose(), receipts: () => receipts };
}
