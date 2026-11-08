# pi-subagents · 配置合同

## 1. 来源与错误处理

user `<agent-dir>/pi-subagents/config.json`，trusted project `<cwd>/.pi/pi-subagents.json`，defaults→user→project。agent-dir 走公开 Pi API/PI_CODING_AGENT_DIR。project 只能收紧 per-Main/per-Agent/timeout/maxDepth，放宽数值 clamp 到 user；process 级 capacity.activeTasksPerProcess/storage.maxStoreBytesPerProcess 仅 user，project 写入拒绝。未 trusted project 不加载。严格 JSON、无重复/未知 key、单文件≤65536 bytes；不自动改用户文件。

schemaVersion 必须 2。删除 execution.helperRuntime/runtimeStopGraceMs、capacity.residentChildrenPerMain/idleResidentsPerMain/residentChildrenPerProcess、storage.maxAgentsPerMain、全部 liveView；maxAgents 改 capacity.openAgentsPerMain（closed 不计）。PI_SUBAGENTS_BACKEND 任意已设置值（含 sdk/空串/process）都拒绝，删除变量。中文诊断带来源、完整 key、修改方式；Main 仍启动/普通输入可用，spawn/send_input/resume 拒绝，close/list/history/accepted delivery 仍可用。

## 2. 当前完整默认与范围

| key | 默认 | 整数范围 |
|---|---:|---|
| execution.taskTimeoutMs | 1800000 | 60000..86400000 |
| execution.maxDepth | 1 | 1..2 |
| capacity.activeTasksPerMain | 10 | 1..32 |
| capacity.activeTasksPerProcess | 10 | 1..64 |
| capacity.openAgentsPerMain | 32 | 1..32 |
| storage.maxTasksPerAgent | 256 | 1..256 |
| storage.maxTasksPerMain | 4096 | 32..4096 |
| storage.maxMailboxRecordsPerConversation | 1024 | 16..1024 |
| storage.maxConversationBytesPerAgent | 67108864 | 1048576..67108864 |
| storage.maxStoreBytesPerMain | 536870912 | 67108864..536870912 |
| storage.maxStoreBytesPerProcess | 2147483648 | 268435456..2147483648 |
| storage.maxMetadataBytesPerMain | 67108864 | 8388608..67108864 |
| storage.maxMailboxBodyBytesPerConversation | 4194304 | 65536..4194304 |
| storage.maxPendingDeliveryBytesPerMain | 16777216 | 1048576..16777216 |

关系：activeMain≤activeProcess 且≤openMain；maxTasksMain≥maxTasksAgent；storeMain≥conversationAgent+16777216；storeProcess≥storeMain；metadataMain≤storeMain。无 unlimited/0 特殊值。

最小配置：

```json
{"schemaVersion":2,"execution":{"maxDepth":1},"capacity":{"activeTasksPerMain":10,"activeTasksPerProcess":10,"openAgentsPerMain":32}}
```

## 3. 生效边界

Task timeout 优先显式 spawn > role > config > default，在 Agent profile 冻结，首次 execution grant 分配 deadline，waiting/retry/compaction 不延长。maxDepth 冻结为 profile.delegation_max_depth，实际 Host 结合当前限制重新核验结构 parent chain；默认 child/grandchild 在 ceiling 时不注册 spawn，不靠提示词禁止。

open 计 lifecycle 不等于 closed，含 idle/waiting/queued/closing；prepared spawn 有效 reservation 计入准入。Task 完成保持 open，只有 close 收口释放名额。active 只计已 grant 执行，waiting 释放、activation 排位，未 drain 取消不释放。配置收紧不能中断已 accepted 工作，只阻止新准入/grant 超过新限制；无 resident/LRU/idle timer。

profile.settings_snapshot 持久保存 allowlisted 公开 Pi settings，execution 深拷贝并固定 native compaction enabled、冻结 model 当前 window 预算；Main settings 不变，resume 不触发 compact。UI 使用 Main 已有 CC 配置，无 liveView override；旧 Pinned entry 只忽略、不加载。source-only 依赖已迁入，修改它或 compiled 源码后须重建直接 consumer；mailbox-v1.0.5 必须配套新 build/fresh process，不能用 /reload 代替。本同步不修改真实 profile，旧存储不读、不转换、不删除。
