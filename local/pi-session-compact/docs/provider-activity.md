# 可选 provider 活动与压缩时钟

共享库 `pi-runtime-contracts/provider-activity-v1` 拥有纯 V1 DTO、频道常量和 `readProviderActivityV1`。Compact 通过 workspace 依赖使用它，不 import provider 扩展。观测由 adapter 拥有，专用事件翻译留在外部。

只在 custom compaction（含 shadow）期间监听 `provider:activity-v1`；结束、总时限、取消或 session 边界清理 subscription/timer。reload/新操作不继承活队列。adapter 缺席正常，所有时钟按真实经过时间计费。

载荷身份为 `{version:1,provider,sessionId,kind}`。只接收匹配当前打开请求 session/provider 的 lifecycle queue：event.channel=lifecycle，source=local/upstream，type=queue.enter/update/leave，可选 attempt 区分来源队列，可选 queuedMs 为权威非负安全整数时长。队列 identity 为 provider/source/attempt。queueEnteredAt 经过共享校验，但不转成本地 monotonic clock。

attempt.start、load.update、turn.end 和 load 计数不影响压缩时钟。未知版本/kind/type、坏字段、缺 source、其他身份及 idle provider 事件忽略。

操作总 deadline 扣除匹配队列区间的并集，不相加。单 attempt 只扣自己的 provider 区间，且受操作共享 pause allowance 限制；不同 provider 不能互停单请求时钟。V1 无 request ID，同 provider 的重叠请求共用 live window 与首次进度截止点，不宣称更细归因。

首个 text/thinking/tool-call delta 关闭该 provider 所有队列，在 live window 结束前不能再暂停。迟到 queuedMs 只校正过去，受 window start、首次 progress 和 cap cutoff 限制。最后一个该 provider 请求结束即关闭队列、丢 correction identity，retry/backoff 不继承；新 retry 的权威时长不能早于自己的 window。

queuePauseCapMinutes 默认 30，须有限正数；独立 wall-time watchdog 即使缺 leave/progress 也限制累积并集。达到 cap 一次关闭全部队列，迟到校正不重开额度。totalTimeoutMinutes 默认 10 active 分钟，0 只关闭总时限。单请求限制、retry、backoff、shadow 共用操作 scope；原生 fallback 不受已耗尽 custom 总预算限制。队列/进度/cap 诊断留在私有 run log。

`tests/deadline.test.ts` 覆盖并集、身份隔离、未知载荷、首进度、迟到校正、累计 cap/watchdog、retry 清理、单请求/总过期与取消。host runner 用中性 faux provider 在新原版 Pi 进程发事件，不访问真实 adapter、缓存、凭据或网络。
