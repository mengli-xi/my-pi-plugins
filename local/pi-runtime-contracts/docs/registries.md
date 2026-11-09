# pi-runtime-contracts

供本地 Pi package 共享的私有、Pi-free runtime coordination contract。

## 导出

- `continuation-v1`：协调 session-scoped blocking lease 与 wake delivery。规范 API 与 state-machine contract 参见 [continuation-v1](continuation-v1.md)。
- `child-capabilities-v1`：让 Main runtime 按 child target 发现受限 entrypoint，并冻结 capability closure。声明本身不授予 provider/tool 执行权限，实际执行方仍须独立批准与验证。
- `provider-activity-v1`：共享 provider/session-scoped activity DTO 与 validator，描述 attempt、queue 和 load；它只提供观测，不调度模型、不修改权限。
- `process-wait-bridge-v1`：保留原有 session-scoped process continuation bridge。
- `process-wait-bridge-v2`：共享 Subagent Task 的 process wait admission 与 lifecycle 通知。
- `goal-continuation-obligation-v1`：只读查询 Goal 是否仍欠指定 continuation，避免 producer 重复 fallback。

SDK 消费者的 view 交接由 `pi-session-runtime` 的 `pi.session-runtime.terminal-owner.v1` 管理；没有 consumer 的旧 `terminal-handoff-v1` 已移除。`PI_CHILD_RUNTIME_TARGET` 仅作为现有兼容导出保留；SDK factory 不依赖该环境变量。

这个 library 不依赖 Pi、TUI 或外部 npm runtime package，不启动 timer 或 network 请求。`child-capabilities-v1` 使用 Node 内置 crypto、filesystem 和 path API 校验 entrypoint 的实际文件身份；其余 contract 保持内存内协调。

## 协议版本与存储 ABI

公开六个 subpath 直接导出 TypeScript source，没有 package 根导出；调用者只 import 所需能力。

`child-capabilities-v1` 的 manifest/register/bind/snapshot DTO 仍是 V1，导出函数名也不变；其全局存储为 ABI2（`pi.child-capability-registry.v2`）。两者是不同层次的版本，不意味着应把 DTO 改成 V2。旧 ABI1 cell 不读取、不覆盖；不兼容的 ABI2 holder 明确拒绝。

`process-wait-bridge-v1` 和 `process-wait-bridge-v2` 是两个独立协议与全局 key。读取或注册时，缺失 holder 才创建；已有 holder 必须是非数组对象，且拥有一个数据属性 `bySession: Map`。全局或 `bySession` accessor、错误类型和继承的 session map 均拒绝，不调用 getter、不覆盖原对象。合法的 mutable/frozen holder 和其中已有 bridge 继续复用，不改变重复注册、旧 disposer、ownerToken 或 continuation admission 行为。

这些 registry 只在当前进程内协调，不是 sandbox，也不替执行方判断操作系统权限。生命周期由各消费者负责，不自动过期或释放所有 handle。

## Goal continuation obligation v1

导出 queryGoalContinuationObligationV1({sessionId,continuationId}) 与 registerGoalContinuationObligationV1(reader)。查询返回 owed/none/unknown，不启动模型、不改 source、不确认 transport。

reader 读取自己的当前分支持久 owed marker，含暂停状态。producer 在 owed/unknown 时保留 fallback；缺 registration 返回 none。owner 未绑定/不可用、holder/result 非法或 reader 抛错返回 unknown。Pi-free holder 使用 Symbol.for("pi.goal.continuation-obligation.v1")，ABI 1，跨 bundle 共用。disposable 只撤自己的注册，旧 dispose 不影响对方；owner shutdown 退役 reader，start 重注册。
