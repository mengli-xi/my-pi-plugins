# pi-runtime-contracts

供本地 Pi package 共享的私有、Pi-free runtime coordination contract。

## 导出

- `continuation-v1`：协调 session-scoped blocking lease 与 wake delivery。规范 API 与 state-machine contract 参见 [`./docs/continuation-v1.md`](./docs/continuation-v1.md)。
- `child-capabilities-v1`：让 Main runtime 按 child target 发现受限 entrypoint，并冻结 capability closure。声明本身不授予 provider/tool 执行权限，实际执行方仍须独立批准与验证。
- `provider-activity-v1`：共享 provider/session-scoped activity DTO 与 validator，描述 attempt、queue 和 load；它只提供观测，不调度模型、不修改权限。
- `process-wait-bridge-v1`：保留原有 session-scoped process continuation bridge。
- `process-wait-bridge-v2`：共享 Subagent Task 的 process wait admission 与 lifecycle 通知。
- `goal-continuation-obligation-v1`：只读查询 Goal 是否仍欠指定 continuation，避免 producer 重复 fallback。

Subagents/Side 的 SDK view 交接由 `pi-session-runtime` 的 `pi.session-runtime.terminal-owner.v1` 管理；没有 consumer 的旧 `terminal-handoff-v1` 已移除。`PI_CHILD_RUNTIME_TARGET` 仅作为现有兼容导出保留；SDK factory 不依赖该环境变量。

这个 library 不依赖 Pi、TUI 或外部 npm runtime package，不启动 timer 或 network 请求。`child-capabilities-v1` 使用 Node 内置 crypto、filesystem 和 path API 校验 entrypoint 的实际文件身份；其余 contract 保持内存内协调。

## 协议版本与存储 ABI

公开六个 subpath 直接导出 TypeScript source，没有 package 根导出；调用者只 import 所需能力。

`child-capabilities-v1` 的 manifest/register/bind/snapshot DTO 仍是 V1，导出函数名也不变；其全局存储为 ABI2（`pi.child-capability-registry.v2`）。两者是不同层次的版本，不意味着应把 DTO 改成 V2。旧 ABI1 cell 不读取、不覆盖；不兼容的 ABI2 holder 明确拒绝。

`process-wait-bridge-v1` 和 `process-wait-bridge-v2` 是两个独立协议与全局 key。读取或注册时，缺失 holder 才创建；已有 holder 必须是非数组对象，且拥有一个数据属性 `bySession: Map`。全局或 `bySession` accessor、错误类型和继承的 session map 均拒绝，不调用 getter、不覆盖原对象。合法的 mutable/frozen holder 和其中已有 bridge 继续复用，不改变重复注册、旧 disposer、ownerToken 或 continuation admission 行为。

这些 registry 只在当前进程内协调，不是 sandbox，也不替执行方判断操作系统权限。生命周期由各消费者负责，不自动过期或释放所有 handle。

## Pi 1.5.0 迁移

本包保持 Pi-free：manifest、lockfile 与生产源码均不依赖 `@earendil-works/*`，因此不需要 Pi 版本适配。消费者升级到 Pi 1.5.0 时仍使用现有 registry、contract version 和 durable receipt；各消费者负责自己的 Pi lifecycle 接入。

安装：`npm ci # 在仓库根运行`。lockfile 使用公开 npm registry，保留现有非 Pi 依赖版本。

验证：`npm run typecheck`、`npm test`。测试只用本地 fixture，并在 fresh Node process 中检查全部六个公开 subpath export；不发送真实 provider 请求。没有 build step；导出直接指向 TypeScript source。

## Goal continuation obligation v1

`pi-runtime-contracts/goal-continuation-obligation-v1` exports
`queryGoalContinuationObligationV1({ sessionId, continuationId })`, returning
`"owed" | "none" | "unknown"`, and `registerGoalContinuationObligationV1(reader)`.
Goal checks the current branch's persisted exact owed marker, including paused Goals.
Processes/Subagents hold fallback on `owed` or `unknown`; an absent registration
returns `none`. An unbound/unavailable owner, invalid holder/result or thrown reader
returns `unknown`. The Pi-free holder uses
`Symbol.for("pi.goal.continuation-obligation.v1")`, ABI 1, shared by bundle copies.
Each disposable removes only its registration; stale disposal cannot remove a peer.
Goal retires the reader on shutdown and registers again on start.
Queries never start models, mutate source state or acknowledge transport delivery.
