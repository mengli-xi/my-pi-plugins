# 可选协作协议

[返回包入口](../README.md)。不 import 或硬依赖别的 extension，不读对方私有 session entry/目录。共享库是正常硬依赖；可选 consumer/producer 缺席不影响 Goal 的基本行为。根 [能力协议表](../../../AGENTS.md#能力协议表) 链接 owner，本页定义 Goal 提供的字段和降级。

## Goal snapshot v1

Goal 发布 `goal:snapshot-v1`，并同步回答 `goal:request:snapshot-v1`，支持 late-loaded consumer 和两种加载顺序。payload 是 `{version: 1, sessionId?, goal}`；没有 Goal 时 goal 为空，存在时只公开：

```ts
{
  id, text, phase, runtimeSeconds, tokensUsed,
  tokenBudget?, queued, observedAt, clockRunning?, queueFrozen?
}
```

`runtimeSeconds`/tokens 由 owner 的 live accounting 派生，不公开 baseline/checkpoint。当前 owner 总是显式给 present Goal 提供 boolean `clockRunning`、`queueFrozen`。broadcast 与同步 reply 共用同一 live reader；请求带 sessionId 时只回答绑定同 session 的 owner，防止拿错 session。

consumer **仅在 `clockRunning === true` 时**按 observedAt 外推 elapsed；active phase 不授予 tick 权限。frozen queue 保留 active phase 但 clock 停止，pause 也停钟；缺 field 的旧 owner 不准猜。

`queueFrozen` 单独表示实际 freeze，不能从 clockRunning/phase 推断。只有 `queueFrozen === true` 才能显示 frozen/`queue off`；普通 paused 不是 frozen，旧 owner 缺 field 也不能猜。无消费者时 Goal 原生 plain status 照常；没有 owner 时 presenter 不显示 Goal 行/材料，也不启动 Goal。

plain status 包括 active、paused、blocked、usage、budget、短暂 complete、queue off，可附 token budget 或活动时间以及 `automatic used/limit` / Unlimited；这是展示，不是要求消费者解析的状态接口。

## Continuation 与 obligation

共享协议由 [Runtime Contracts](../../../local/pi-runtime-contracts/README.md) 提供：

- `continuation-v1` / `pi.runtime-contracts.continuation.v1`：Goal 可接管同 session 的后台 offer，先持久化 owed，再同步给 producer `pi-goal-local` consumer receipt。没有 Goal consumer 时 producer 走自身公开 fallback；库不调用模型。
- `goal-continuation-obligation-v1` / `pi.goal.continuation-obligation.v1`：Goal 注册 reader，按 exact sessionId + continuationId 查询 `owed | none | unknown`，包含 paused Goal 的义务。无匹配目标/marker或 foreign source 是 none；unbound/incompatible state 或无法确认 scope 是 unknown。无 reader 按 registry 合同为 none；unknown 要保留 pending，不能抢 continuation。shutdown 只释放自己的 reader token。
- Subagents 的 `pi.subagents.producer-continuation-proof.v1` 是生产方 owner 的能力。没有兼容 registry 就不 claim Subagents，由 producer 自行唤醒；不能 import 其 extension 实现或假造 receipt。

branch/source scope、coalescing 与 ACK 见 [Mailbox](mailbox.md)。没有 Processes/Subagents，Goal 仍可独立完成普通任务；Task/process deadline 不归 Goal 控制。mailbox 是共享库 transport，不是必须另装的 extension；它缺有效 owner 时保留 pending，不做 private fallback。

## Managed RPC 旧兼容

这是既有、**无版本、默认关闭**的 managed-run 兼容接口，不符合新协议必须带版本号的命名约定，但保留当前 grammar，不改名、不声称 versioned，也不另增 RPC API。仅在 `rpc.enabled: true` 时接受 start。已安装 extension 全部有宿主权限，此开关只是合作开关，不认证 caller，不隔离权限。

channel 原样保留：

```text
pi-goal:start
pi-goal:cancel
pi-goal:event:${runId}
```

调用方生成 session-unique runId（建议 UUID），**先订阅 event channel，再 emit start**：

```ts
pi.events.emit("pi-goal:start", {
  runId: "consumer-generated-run-id",
  objective: "实现并验证功能",
  tokenBudget: 100000, // 可选，正 safe integer，不接受 k/m 字符串
});
```

runId 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，只是 correlation id，不是 secret/身份。objective 与命令一样 trim、非空、最多 4,000 字符。缺失/unsafe runId 忽略，因为没有安全回复 channel。emit 返回不等于 Goal 完成。

成功和后续 canonical persistence 事件：

```json
{ "type": "state", "runId": "consumer-generated-run-id", "goalId": "<instance-id>", "status": "active" }
```

status 为 active、complete、blocked、paused、usage_limited、budget_limited、cleared。只有 complete 是成功 terminal；complete 可带 summary，其他 terminal 可带 reason。相同 persistence 不重复状态，每 run 最多一个 terminal。只广播 exact managed run，不 adopt manual/restored Goal。terminal 在底层 transition settled 后发出，complete listener 可开始下一 managed run而不重入旧清理；其他 terminal 保留 stopped Goal，先解决/clear。

manual edit/replace/skip/priority 令 Goal id 轮换时，旧 managed run 以 cleared + superseded reason 结束，新 Goal 不属于旧 run。reload、replacement、shutdown 清除内存 ownership，不靠恢复 Goal 复活 managed run。

cancel 使用相同 runId，可在 activation 前后发：

```ts
pi.events.emit("pi-goal:cancel", {
  runId: "consumer-generated-run-id",
  reason: "调用方已取消", // 可选，trim 后最多 1,000 字符
});
```

cancel 走正常 Goal pause（含 durable cancel barrier），不能影响 manual/restored/stale/其他 run。paused state 就是 cancellation result，没有独立 reply envelope；失败不能假装 paused。terminal runId 不可重开，后来 manual resume 不属于已终止 run。关闭 rpc.enabled 拒绝新 start，但已有 accepted run 到 terminal 前仍可报状态/接受 exact cancel。

拒绝事件：

```json
{
  "type": "error", "runId": "consumer-generated-run-id", "operation": "start",
  "error": { "code": "RPC_DISABLED", "message": "Managed run RPC is disabled." }
}
```

operation 为 start/cancel；稳定 code 是 RPC_DISABLED、INVALID_REQUEST、NO_ACTIVE_SESSION、RUN_ID_IN_USE、RUN_NOT_FOUND、GOAL_ALREADY_EXISTS、ACTIVATION_FAILED、SUPERSEDED。consumer 按 code 分支，message 仅诊断。start 从不弹 replacement confirmation，任何已有 Goal 都拒绝。settings 与 restored state 加载后才 bind，shutdown 前 unbind；caller 自己清理 session-owned listener/pending work，不能假定 bus 上一定有 Goal owner。

旧 `pi-goal:rpc:start`、`pi-goal:rpc:pause`、request-scoped start replies 和全局 `pi-goal:state` 不注册 alias；不能把它们当 fallback。
