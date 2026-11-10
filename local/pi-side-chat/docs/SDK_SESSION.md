# SDK 会话与 ownership

## 装配边界

`SdkSideCoordinator` 拥有 Main 生命周期、打开/返回/销毁状态与 terminal handoff；`SideRuntime` 拥有独立 SDK services、session 与私有目录；`SideView` 只拥有一次前台 view。普通返回销毁 view，不销毁 Side execution。空闲时不创建 Side session；创建后可能与 Main 同时执行。

上下文 capture、native seed、canonical SDK realm、factory loader、managed view 和 terminal ownership 使用 [Session Runtime](../../pi-session-runtime/README.md)；版本化 descriptor 使用 [Runtime Contracts](../../pi-runtime-contracts/README.md)。调用方仍负责选择、执行授权与释放，共享库不代为发现 provider 或批准执行。

Side 优先采用 Main 最后实际 model-visible request，包括晚到的转换，再补稳定原生 tail；部分 assistant 与未闭合 tool batch 不继承。缺失、身份不符或过期 capture 不得静默恢复被压缩/丢弃的 raw history。原生记录回退需要明确的一次接受。继承前缀是背景，不是 Side 的待执行指令；boundary 提醒模型仅按之后的请求修改文件。

## 工具、provider 与 presentation

Main active tool list 投影到 builtin、Bash Timeout、Processes Side factory、Search 和显式批准的 provider catalog，不复制未知 Main extension。

- Bash Timeout 使用自己的 `pi-side-chat` required-only target 和 `extensions/child.ts`，核对 Main ownership、factory artifacts 与 tool definition fingerprint。已启用 override 后 drift 必须拒绝，不能换成无必填 timeout 的 builtin；Main 未启用 bash 时不激活它。
- Processes 使用具名 `createProcessesSideFactory`，scope 属于 Side session，不创建 Subagent Task bridge；factory 必须提供 `cancelPending()`。
- Search 接 Main event bus 发现明确安装的 backend contribution，不隐式启用其他扩展。
- 外部 provider 必须声明独立 Side target，并取得实际 `<agent-dir>/sdk-provider-grants.json` 的精确批准。Subagents 的 target/grant 不代表 Side 授权。冻结模型 scope、factory/artifact/observer 指纹与后续 binding revalidation 都保留。
- CC Style 的 `target: "side-chat"` factory 仅提供 presentation，tools/providers/commands 为空，不提供 `sdk_provider_factory`。没有该 target 时用原生 view；已发布但非法、冲突或 hash 漂移时仍拒绝。注册不等于执行批准。

共享 provider 装配机制见 Session Runtime；Side 不 import Subagents 或其他插件的生产模块，不读取其私有存储。

## 模型、压缩与设置

Side 模型/effort 可在 frozen scope 内切换；selector `Ctrl+S` 只更新 Side 内存 defaults，不修改 Main 或 settings 文件。`/copy` 只允许 Side 自有且可复制的非空 assistant 答案。

Side 的原生 compaction 始终在内存 settings 开启，预算使用当前模型。seed 过大时只使用已授权、容量足够的模型摘要，之后恢复所选模型；没有合适模型就失败。首个 normalized request prefix 只保留一次，之后释放；模型/effort 切换或 compaction 使其退役，后续以原生 projection 为准。cache 是否复用只能从真实 provider usage 观察，不能从 prefix 相同推断。

## 销毁与失败重试

私有 JSONL 位于实际 `<agent-dir>/pi-side-chat/runtime/<uuid>/side-session.jsonl`，目录0700、文件0600。Main session shutdown（new/resume/fork/clone/reload/quit）销毁 Side；普通返回不调用销毁接点，不支持跨进程恢复旧 Side。

销毁顺序：`beforeDispose(cause)` 完成 source durable cancellation → retire policy → interrupt → dispose SDK runtime/scope → 删除本 slot 目录。Processes 只取消该 Side slot 自己的 pending keys。cause 区分 destroy、main-shutdown、runtime-shutdown、startup-failed。

取消失败必须保留 runtime/目录与 cleanup ownership，向调用方传播错误，允许下一次 destroy 重试；不能清空句柄后新开 replacement。Main shutdown 抢先于 opening 时同样保留未发布资源的 ownership。`SideStartupCleanupError` 保存 directory 与 `retryCleanup`；没有创建资源的 opening 取消可直接结束。

这是同进程 cooperative cleanup，不是 sandbox，也不能硬杀任意 JS。Main、Side 与工具共享文件/网络/credentials；并发修改没有自动文件锁。
