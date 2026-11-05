# pi-runtime-contracts · Continuation V1 规范 API

该 package 是不依赖 Pi 的原创私有 library。初始 public export 只有：

```text
pi-runtime-contracts/continuation-v1
```

除 owner handle 外，所有 interface/result 都是 deeply readonly。即使已有 TypeScript type，runtime
代码仍会校验所有 external string。

## 常量与 registry

```ts
export const CONTINUATION_V1_API = 1;
export const CONTINUATION_V1_SYMBOL =
  Symbol.for("pi.runtime-contracts.continuation.v1");

export function getContinuationRegistryV1(): ContinuationRegistryV1;
```

首次调用会在 `globalThis` 上安装一个不可配置的 registry holder。symbol 下已有不同
API/version/shape 的 holder 时，抛出 `[runtime-contracts/incompatible-registry]`；绝不覆盖它。
independent module copy 会返回同一个 object。

每个 session 的 closed limit：

- blocking lease/reserved release offer：256；
- open detached wake offer：256；
- 一个 active wake consumer；
- subscriber：64；
- ownerId 为 1..64 个 ASCII 字符，匹配 `[a-z0-9][a-z0-9._:/-]*`；
- logicalKey 为 1..256 UTF-8 bytes，不含 control；
- reason/message 为 0..512 UTF-8 bytes，trim 后为单行 safe line；
- sessionId 为 1..512 UTF-8 bytes，是 opaque 值且不含 control。

## 类型

```ts
type LeaseOutcome = "ready" | "failed" | "cancelled";
type DeliveryOutcome = "delivered" | "skipped" | "delivery-failed";
type HandleError = "stale-handle" | "already-settled" | "capacity" |
  "invalid-input" | "consumer-replaced";

type Result<T> = { ok: true; value: T } |
  { ok: false; error: HandleError; message: string };

interface BlockingLeaseSnapshotV1 {
  sessionId: string;
  leaseId: string;       // library CSPRNG 128-bit base64url
  generation: number;    // monotonic within logical key
  ownerId: string;
  logicalKey: string;
  reason?: string;
  acquiredAt: number;    // Date.now milliseconds
  lastCheckInAt: number;
}

interface RegistrySnapshotV1 {
  apiVersion: 1;
  sessionId: string;
  registryVersion: number;
  blocking: readonly BlockingLeaseSnapshotV1[];
  openOffers: number;
  consumerGeneration?: number;
}

interface WakeOfferSnapshotV1 {
  sessionId: string;
  offerId: string;
  offerGeneration: number;
  createdAt: number;
  reason: string;
  outcome: LeaseOutcome;
  releasedLease?: BlockingLeaseSnapshotV1;
  remainingBlocking: number;
  state: "open" | "claimed" | "committed" | "aborted";
}

interface WakeSettlementV1 {
  offer: WakeOfferSnapshotV1;
  state: "committed" | "aborted";
  delivery?: DeliveryOutcome;
  message?: string;
}
```

snapshot 按 lease acquire time 再按 lease ID 排序，均会 deep-freeze，且不会共享可变的 internal
collection。

## registry API

```ts
interface ContinuationRegistryV1 {
  readonly apiVersion: 1;

  acquireBlocking(input: {
    sessionId: string;
    ownerId: string;
    logicalKey: string;
    reason?: string;
  }): Result<BlockingLeaseHandleV1>;

  offerWake(input: {
    sessionId: string;
    ownerId: string;
    logicalKey: string;
    reason: string;
    outcome: LeaseOutcome;
  }): Result<WakeProducerTransactionV1>;

  snapshot(sessionId: string): RegistrySnapshotV1;

  subscribe(
    sessionId: string,
    listener: (snapshot: RegistrySnapshotV1) => void,
  ): Result<DisposableV1>;

  registerWakeConsumer(input: {
    sessionId: string;
    consumerId: string;
    onOffer: (offer: WakeOfferSnapshotV1, claim: () =>
      Result<WakeClaimHandleV1>) => void;
  }): Result<DisposableV1>;
}

interface DisposableV1 { dispose(): void }
```

`acquireBlocking` 对仍 live 的相同 `(ownerId,logicalKey)` 返回 `invalid-input`；caller 应更新
既有 handle，而不是替换它。它会为该 lease 最终的 release offer 预留 capacity，因此 release
永远不会因 offer capacity 丢失 wake arbitration。

`subscribe` 会立即用当前 snapshot 调用一次 listener，之后每次 committed registry mutation 后
再调用一次。registry 先 mutate，再 snapshot 一个稳定的 listener list，并按 registration order
同步调用。reentrant mutation 会在当前 callback 后排入另一轮 dispatch；listener throw 会被捕获，
不会 rollback 或停止其他 listener。stale disposer 是 idempotent 的。

注册 wake consumer 会原子地递增 generation、retire 旧 consumer，然后按创建顺序同步 replay
所有 open session offer。旧 consumer 的 disposer/claim 会得到 `consumer-replaced`。callback throw
会被捕获，并使 offer 保持 open/unclaimed。

## lease handle

```ts
interface BlockingLeaseHandleV1 {
  snapshot(): BlockingLeaseSnapshotV1;
  updateReason(reason?: string): Result<BlockingLeaseSnapshotV1>;
  checkIn(): Result<BlockingLeaseSnapshotV1>;
  releaseWithoutWake(input: {
    outcome: LeaseOutcome;
    reason?: string;
  }): Result<BlockingLeaseSnapshotV1>;
  releaseAndOfferWake(input: {
    outcome: LeaseOutcome;
    reason: string;
  }): Result<WakeProducerTransactionV1>;
}
```

只有精确匹配的 lease/generation handle 可以 mutate。check-in/update 会递增 registry version 并
通知 subscriber。`releaseWithoutWake` 会移除 lease/reservation，用于 scope teardown、detached
reconfigure 或 start rollback；它不会创建 offer。`releaseAndOfferWake` 会原子地移除 lease、
snapshot `remainingBlocking`、消耗其已预留的 offer slot，并在返回前将 offer 交给当前 consumer。
所有 release method 都会将 handle settle 一次。

没有 timer 会自动 release lease。library 不会调度 Pi work。

## Producer transaction 与 claim

```ts
interface WakeProducerTransactionV1 {
  snapshot(): WakeOfferSnapshotV1;
  hasClaim(): boolean;
  commit(delivery: DeliveryOutcome): Result<WakeSettlementV1>;
  abort(message: string): Result<WakeSettlementV1>;
}

interface WakeClaimHandleV1 {
  snapshot(): WakeOfferSnapshotV1;
  onSettled(listener: (settlement: WakeSettlementV1) => void): Result<DisposableV1>;
}
```

`offerWake` 从 detached-offer capacity 中预留位置，创建 open offer，并同步调用当前 consumer。
consumer 只能在 callback 期间或之后、自己仍为 current 且 offer 仍为 open 时调用 `claim()`；每个
offer 只能有一个 claim。同一 handle 重复 claim 会返回既有 claim；其他或 stale 的 attempt 会失败。

producer 必须严格遵循以下步骤：

1. 创建 transaction（或 release-and-create）；
2. 检查 `hasClaim()`；
3. 持久化对应的domain notification artifact，并用session leaf/entry证明它已落盘；artifact可以是lifecycle custom entry、带匹配operation/fact identity的process tool result或persistent hidden batch。若已claimed，则不要请求independent turn；
4. 按transaction类型提交：blocking lease release在自己的domain artifact落盘后调用`commit("delivered")`，包括`attention:"ignore"`路径；没有artifact证据时保持open/retry，scope结束时abort，绝不能skipped。standalone offer在模型通知已落盘时`commit("delivered")`，当前user epoch已承载或owner明确拒绝model delivery时可`commit("skipped")`；delivery failure时调用`abort(message)`；
5. 若 standalone commit 未被 claim，则在 commit 后应用其 domain fallback attention。blocking lease是否驱动Goal只由consumer自身policy决定，与notify attention无关。

没有 `RuntimeBinding` 时，process 保持 transaction open。replacement goal consumer 可以通过
replay claim；replacement process binding 会 delivery 后再 commit。Host 销毁时，会在 dispose 前
abort 每个由 owner 持有的 open transaction。

commit/abort 都是 terminal 操作，并会递增 registry version。claimed settlement listener 会从稳定副本中同步运行；callback throw会被隔离。
`delivery:"delivered"`表示该transaction要求的domain notification artifact已经持久化，consumer才可按自己的policy调度；它不要求模型已经消费该通知。
`delivery:"skipped"`只适用于standalone offer，表示当前user epoch已经承载通知或owner明确拒绝model delivery，consumer绝不能调度。blocking lease release不得因attention为`context|ignore`、run-abort fence或record-only路径而提交`skipped`；`ignore`只抑制模型通知，不抑制lifecycle entry/tool result的artifact持久化和blocking dependency推进。
`delivery:"delivery-failed"`和aborted settlement也不得调度。goal policy会claim partial release，并在committed + delivered时就调度，不等`remainingBlocking === 0`（D-008、ADR-0018）：每个producer的completion各自具备wake资格，`remainingBlocking`只作observability。同一个安全处理边界上到达的多个committed offer，goal自行coalesce成一次turn，并返回`scheduled`/`coalesced`区分；处理完之后，仍存活的lease才继续延迟goal后续的普通continuation。

unclaimed committed offer 会立即移除。claimed committed/aborted offer 会在 settlement callback 后
移除。open offer 没有 library timeout；domain owner 控制其 lifetime。offer/claim handle 不能
release/reacquire lease。

## detached offer 容量失败

若 `offerWake` 返回 `capacity`，producer 仍会发出其 domain notification 并应用配置的 fallback
attention；同时记录 diagnostic。blocking release 不会走这条路径，因为 acquire 已预留其 slot。

## Clock、ID 与可测试性

production singleton 使用 `Date.now()` 和 CSPRNG。internal factory（不在 package export map 中）
接受 clock/ID hook，以支持 deterministic test。public caller 不能注入 timestamp/ID/generation。

## 错误行为

预期的 stale/capacity/input state 返回 `Result`；incompatible global holder 或 internal invariant
corruption 会抛出稳定的 `[runtime-contracts/<code>]`。listener error 会被隔离，并可选地发送到
factory composition 中设置的一个 internal diagnostic callback；library 没有 filesystem/console/Pi
依赖。

## 必需 invariant

- registryVersion 会在每次 committed mutation 后严格递增；
- 每个 `(session,owner,logicalKey)` 只有一个 live lease；
- release-and-offer 是一次同步 mutation；
- lease acquire 会预留一个有保证的 release offer；
- 每个 offer 只有一个 consumer generation 和一个 claim；
- stale handle/disposer 不会影响 replacement；
- producer commit 前不得 continuation；只有committed `delivery:"delivered"`允许consumer按policy调度，`skipped`与`delivery-failed`绝不调度；blocking lease release在domain notification artifact持久化后必须使用`delivered`，只有standalone offer可以使用`skipped`；
- 每个 open offer 都会由 owner commit/abort；
- runtime implementation 中不得 import 或提及 process/goal/Pi。
