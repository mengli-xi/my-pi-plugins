# pi-session-inject

source-only 的 Pi-aware 共享库，维护 safe append primitives 与统一 mailbox transport。只使用 stock Pi 1.5 的公开 API，无 extension factory 或 build step，无需加入 Pi 的加载 packages。producer 通过 bindMailbox 接入，首次 session_start 为每个 runner 注册稳定 `/mailbox` facade；单独安装本库不会启动任务或自动发现 producer。

导出 API：

- `mailbox-v1/light`：生产 producer 的启动入口，保留同步身份、注册与 `/mailbox` facade；空会话不加载重引擎。首次投递、恢复或命令按进程共享一个带 build 校验的引擎 promise/namespace。原完整入口仍供同步 parser/schema API 使用。

- `mailbox-v1`：通用信箱的 [冻结接口与运行时合同](./mailbox-v1.md)，含 durable put/cancel、legacy fulfilled importer、可重放 recorded/terminal ACK、participant、exact JSON schema、scope fencing、三类 live submitted 与稳定 command facade。单库测试不替代消费者联合验收。原 safe append primitives 保留，不作为 producer 私发消息 fallback。
- 根入口或 `open-tail-tool-calls-v1`：`openTailToolCallIds()`、`BranchSession`。只判断最新 message tail；忽略 compaction 等非 message entry，不承担整条 branch 的历史审计。
- 根入口或 `append-at-safe-boundary-v1`：`appendAtSafeBoundary()` 在 idle、当前 authority 且无 open tool call 时发送 custom message，再等待 native entry proof；`proveNativeEntry()` 按 identity、内容和 SHA-256 验证唯一 entry，供恢复和幂等检查使用。对应类型为 `SafeAppendOptions`、`SafeAppendResult`、`NativeEntryProof`。
- 根入口或 `types`：`IdleAppendBoundary`、`LiveMessagePort`、`SessionManager` 类型。调用方提供 live runtime boundary 和 message port。

Processes、Goal、Subagents、Scheduler、MCP Adapter 通过 producer 接口接入，各自仍拥有业务 guard、身份、持久业务状态与 domain settlement。本库只拥有 transport；Main/Side/child 分 session slot，不能相互改投。producer ID 由参与方注册为非空字符串，不自动发现或加载插件。注册可声明 `capabilities.activateNewExecution: true`，仅允许证明首次新 execution；不会授予业务 Task/grant 权限。未声明时不能激活，所有恢复、首轮与 token 校验保持不变。

## 投影、读取与存储边界

- 每次真实请求重新检查 guard；已 recorded 但被 hold/cancel/project=false 拒绝的通知，也要从当前请求上下文过滤，不改原历史。合法 live/fulfilled key 对同一 carrier 的引用可保留。无法安全投影时调用公开 abort，并清空当前请求可见列表，不能靠抛错或告警让 Pi 沿用原消息。
- readonly projection 只读取持久事实及当前 slot 已知的拒绝/错误，不调用 guard 或授予新权限；它不证明业务权限实时有效。正式请求仍由 delivery owner 逐次校验。
- snapshot 由同一 writer lock 管理：首次取得锁时读取，后续复用现有内存 snapshot；自己成功落盘后更新内存。metadata 变化、重获锁或写入结果不确定时重新读盘，锁和 fsync 检查不缓存。
- session JSONL 按 identity 只保留最新版解析结果及 entry 索引，合并并发读取；dev/inode/size/mtimeNs/ctimeNs 变化就整份重读，读取期间变化或失败不沿用旧结果。同 inode 并发增长单独报 `read-race`，`readDiskSession()` 单次调用最多尝试 3 次（含完成时版本复核），不 sleep、不定时轮询；只有稳定字节才解析和缓存。读取中替换、截断、等长改写，以及稳定的坏 JSON、身份/branch/正文/proof 不符，仍按原错误拒绝，不能借重读放宽验证。
- 有界读取仍遇到 `read-race` 时，只在内存保留拒绝与诊断，不写持久 `suspended`、不自行循环调度。首次 ready 可保留已取得的 writer lock，但验证完成前不投递、不 replay ACK；后续真实 lifecycle、producer admission 或 `/mailbox resume` 边界重新验证。投影失败仍 abort 并返回空列表；只有当前请求由读取竞争触发、且 signal 尚未 aborted 的内部 abort 不写持久 aborted suspension，普通用户中断和真实错误照旧停用。readonly projection 遇到未完成的 owner 验证也拒绝，不能沿用未授权 messages。
- 没有增量索引、后台轮询或永久全路径历史 cache，binding 退役会释放其解析结果。readonly reader 状态随 SessionManager 生命周期保留，不授予执行权限。
- snapshot/receipt 保存完整正文、图片与 details，不脱敏、不加密。新 snapshot 文件使用 0600，已有目录权限由 owner 管理。GC snapshot 不等于删除会话中的正文/receipt，也不按时间清理临时残留。
- accepted、recorded、fulfilled 与业务成功不等价。cancel 不能撤回已提交原生队列或已冻结/发出的请求；关闭 producer、退出或 `/mailbox resume` 都不替代业务取消/授权。

当前 transport build 为 `mailbox-v1.0.6`。transport build 标识变化后，编译型消费者必须 rebuild 并新开进程；不以 `/reload` 代替源码重建。API/schema 保留，旧不兼容 holder 拒绝接入，不覆盖或静默降级。

## 验证与使用回归

运行 `npm run check`（含 transport SIGKILL 矩阵）、`npm run test:native`、`npm run test:followup`；后两项用 `PI_BIN` 指定 stock Pi（缺省用仓库根安装的 CLI），并安装 Bun。用隔离 HOME/agentDir/cwd/TMPDIR、offline faux 和网络拒绝 fixture，不读日常凭据或会话。真实 Goal 回归另需已获确认并重建的 `MAILBOX_GOAL_BUNDLE`，未提供就不宣称验证了 Goal。通过 workspace 依赖 引用，public exports 直接指向 TypeScript source。

取消投影 native 场景在观察到对应终态后，等待整个空信箱目录被 GC，再推进下一步。

消费者另行安装后，在 disposable profile 用 faux 回归：

- 投递一条通知，检查 accepted、recorded、fulfilled 和 source ACK 分别成立；重复同 key 不重发，换正文报 conflict。
- 通知已 recorded 后让 guard hold/cancel/project=false，再发正常用户输入；原历史仍在，但请求不带被拒绝正文。另一个合法 key 共享 carrier 时不得误删。
- 在临时会话故障注入中让投影读盘失败；当前请求应 abort，不能发出原上下文。真实坏数据须修复存储、恢复权限并显式 resume；读取竞争则在后续安全边界重新验证，无须清除持久 blocked，也不自动伪造成功。`mailbox-read-race.test.ts` 用真实 FileHandle 的可控 append 覆盖稳定重读、持续竞争、首次 ready、回调 proof 和投影 abort/恢复；原版本缓存、替换与坏数据回归仍须通过。
- 切换/导航会话后完成旧异步工作，应得到 stale-binding 而非投进新会话。重启恢复旧 pending 时先保持 recovery hold；resume 只解除 transport hold。
- 检查 `/mailbox` 空/部分/未知输入补全与真实 recover ID；恢复应进入明确显示的原目标，不悄悄投到当前会话。
- 中断 ACK/写入后重启，稳定 token 应重放、不新增模型请求；snapshot 只在可验证 receipt 替代最后副本后清理。文件版本没变时不重复解析，追加/替换/截断后读到新状态。

真实 provider/wire/cache、人工 TUI、完整消费者 profile 与生产内存规模需另行验收；进程 SIGKILL/I/O 测试不证明断电级 session fsync 保证。
