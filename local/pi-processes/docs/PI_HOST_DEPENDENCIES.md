# Pi 宿主、SDK 与界面合同

## 公开宿主接口

本包以 stock Pi `1.5.0` 为基线，只使用公开 API，不新增 Pi private seam、probe 或宿主补丁。

Processes notification transport 由 source-only `pi-session-inject/mailbox-v1` 拥有。Pi native queue、receipt、control、context recovery 与多 bundle/lifecycle fence 的宿主行为检查归该共享库；endpoint stub 不能替代真实 transport 验证。

Processes 使用 producer 的真实 beforeRun/afterRun/settled callback：可信 external candidate 的 prepare/put 必须在 mailbox 的 before_agent_start ingress cutoff 前完成；native proof 必须属于原 active branch，`pending` source marker 与独立 lease receipt 持久后才 commit broker/wake。完整规则见 [Mailbox 合同](MAILBOX.md)。

`process-compact-state-v1` 通过公开 `triggerTurn:false` 路径恢复 owner snapshot，不增加自动请求。同步 collector 与无 marker 的独立补注规则见[压缩状态恢复](MAILBOX.md#压缩状态恢复)。升级 Pi 时仍须检查 public lifecycle、input、custom entry、tool-result ordering 与 compaction 行为，不把公开 API 的行为检查改成私有 probe。

配置来自调用会话实际 `getAgentDir()/pi-processes/config.json`；`getAgentDir()` 遵守 `PI_CODING_AGENT_DIR`。custom/user 两种起跑都处理，起跑不依赖 `isIdle()` 为 true。验证入口见[本包 README](../README.md#验证)，测试必须使用隔离 HOME、agent directory、持久 SDK sessions 与 faux provider；跨插件矩阵见[根 integration](../../../integration/README.md)。

## 按需 runtime 与构建边界

Pi 加载 `dist/index.js`。构建还生成 `dist/supervisor.js`、`dist/matcher-worker.js`、独立 child/factory entry 和 `dist/manager-view.js`。空会话只建立 Host/binding，不启动 Supervisor；首次 process tool 操作等待 runtime selection 和完整握手。并发首次操作共用一次启动，失败不发送请求，后续操作可以重试。

helper runtime 每次尝试从 spawn 起有 10 秒总探测预算，包含等待输出管道关闭。运行时已退出时，stdout/stderr 最多再等 2 秒，且不延长这 10 秒预算：仅有 exit=0 或有效版本行不足以成功，后台子进程保持管道打开也属于 `timeout`。这样既不漏读迟到的 stderr，也不会为了已退出的运行时等满 10 秒。正常 close 到达后才验证完整 nonce、stdout/stderr 和版本；管道被强制关闭时绝不把截断输出当成功。

任一期限到点后尝试 SIGKILL 探测进程组，并至多再给 2 秒等待回收/pipe 关闭。仍未关闭则 destroy 两个读管道、unref 子进程句柄并返回 `timeout`，不依赖 close 才结束。脱离进程组的子进程可能逃过信号；此兜底保证探测调用不被其管道阻断，不宣称这些子进程已全部回收。运行时/包装脚本应关闭继承的输出描述符，不应在 probe 后保留后台 helper。

只有 `timeout` 重试一次；重试失败才继续下一个候选。单候选两次尝试的预算最多约 24 秒（含清理，不含调度延迟），not-found/not-executable、spawn-error、输出不合法和版本不符不重试。重试仍失败时，诊断的 detail 同时列出 `first attempt` 的 timeout 原因和 `retry` 的最终结果；成功重试不保留失败诊断。

不缓存跨 Host 的成功探测：同一个 Host 已有 transport 或启动中的 promise 会复用，无需重复探测；fresh scope 重新验证实际 executable 和 Supervisor entry，避免 runtime 路径、符号链接目标或构建产物替换后复用过期结果。普通二进制的探测通常只需毫秒，10 秒是高负载的等待预算，不是固定延迟。

普通配置下，已有 transport、启动中的任务或 record 在 reload/rebind 时沿用原 readiness 流程；managed/isolated 不 reclaim 旧 Host，执行与 cleanup 规则见[执行合同](MANAGED_EXECUTION.md#reload-与-scope-cleanup)。源码或 source-only library 依赖变更后须重建并新开 Pi process，不用 reload 替代构建验证。

`/ps`、strip 与 status protocol 同步注册，管理面板和 UIKit overlay 首次打开时才 dynamic import。`verify-dist` 防止 manager view 重返首帧静态图。加载期间关闭面板或替换 session，会使旧 generation 失效，不会迟到重开旧 UI；导入失败显示错误。

## Subagent child factory

`dist/child.js` 是 capability descriptor 校验使用的 named SDK factory 导出入口。显式 factory 只注册 `process` tool、ProcessHost 和 Supervisor lifecycle，不安装 `/ps`、strip、statusline 或 TUI，也不安装 Main/Side 的 compaction snapshot helper。

同进程 SDK 装配使用 `dist/child-factory.js` 的 `createProcessesChildFactory({ sessionScopeId, agentDir, getBridge })`。`sessionScopeId` 为该 session ID，`getBridge(scopeId)` 注入 `ProcessWaitBridgeV2`，不需要 child 环境变量。每次安装只拥有对应 scope 的 Host、通知和 shutdown；空 scope 不启动 helper。`dist/child.js` 同时导出该 named factory，保留显式 descriptor 路径与 hash；Main 为 Subagents/Side 分别声明模块、export 和完整性证明，格式与通用校验只写在 [child 合同](../../pi-runtime-contracts/docs/child-capabilities-v1.md)，不依赖旧 OS 环境变量包装。

`turn` attention 先经共享的 `pi-runtime-contracts/process-wait-bridge-v2` 请求 Subagent Host admission。只有当前 Task 仍 active，或仍 `waiting_on: process` 并取得 active-only grant，才可触发 child turn。Task 已 final/settled 后到达的 process terminal 只追加 TUI-only lifecycle entry，不进入模型上下文，也不重新唤醒 child。Process wait 只恢复 child 一次，child Completion 再唤醒 direct parent。

child 用 `{ recovered: true }` 接管原 frozen intent key。若明确取得的当前 ownerToken 与 intent 中旧 Task/generation 不同，source 等待原 endpoint 取消落盘；cold hold 不阻止取消。相同 owner 不取消；bridge 缺失或 owner capture 失败则保持 hold、留诊断，等待 owner 恢复或用户处理。恢复不申请 continuation admission、不重跑 process，也不把旧正文投给新 Task 或 Main。

idle attach 尚无 active Task 时保存恢复 intent，后续 `beforeRun` 等待重评原 owner 并取消明确失效的原 key，不再次 put 或释放 cold hold。终态 callback 完成后移出恢复集合，新 live mail 不加入这次重评。owner 撤权前的 `cancelPending` 合同见 [Mailbox 合同](MAILBOX.md#execution-owner-结束接点)。

## Side factory

`dist/index.js` 导出 `createProcessesSideFactory({ sessionScopeId, agentDir })`，在私有 Side scope 安装普通 conversation notification coordinator，不安装 Main UI/status、capability registration 或 Subagent Task bridge。Side 使用独立 conversation mailbox slot，不借 Task bridge。

Side execution owner 可使用这个显式 SDK factory。view detach 不卸载 execution factory；shutdown（包括 reload）只 retire 本 scope 和它的 helper/descendants，Main 和其他 child 保留自己的 Host。destroy 前须按 [cancelPending 合同](MAILBOX.md#execution-owner-结束接点) 取消冻结 source obligations，失败时保留 runtime/源目录以便重试。

## 界面与故障展示

`/ps` 使用共享 `ProcessPanel`。SearchSelect list 在稳定列显示 `name · status · runtime`，所有 command 从同一第四列左对齐。focused row 只改 foreground colour，不绘制 background block。Enter 在 input editor 原位置打开 full-width detail overlay，显示 kind、status、live runtime、完整 script、retained output 与 logical line count。`f` 切换 follow newest output；滚动或 `g` 暂停 follow，`G` 跳到末尾，`x` 经确认停止 live process。

detail 两侧缩进；加粗的 `Status` / `Runtime` / `Scripts` / `Output` 标签构成一个 block，divider 分开 `Output` 与 log。log 和两条 output divider 使用普通对话 text colour，末尾采用 UIKit panel 的右对齐 hint divider。live status 为蓝色，成功显示绿色 `success`，确定的失败 exit 显示红色 `exit x`，黄色保留给 timeout。真实 process deadline 显示为黄色 `timeout`，终态仍是 `failed`；matcher/protocol timeout 不冒充 command timeout。

editor 上方的独立 strip 右对齐显示 `ps · name · name`，让 spinner tool 与 Todo 在其上方连续排列。`ps`、separator 与 chrome 保持 muted；name 同等 dim，并以 live 蓝色、succeeded 绿色、failed/killed/crashed 红色、intentionally stopped muted 区分状态。terminal name 保留 5 秒后隐藏，不删除 retained record。点击 name 直接打开 detail，Esc 关闭这次 invocation；`/ps` list→detail 保持 nested Escape，先回 list。role count 只在可点击 statusline 聚合，本包不自行 render statusline。

UIKit 拥有 presentation 与 invocation-local navigation，本包拥有 process data、log retrieval 与 lifecycle action；不注册其他 `/ps:*` command。可选 status consumer 缺失时，本地工具、strip 和 panel 不受影响。

### Containment 展示

Supervisor 失联后的 cleanup 状态由 Host 提供，[执行合同](MANAGED_EXECUTION.md#supervisor-失联后的-containment) 定义 TERM/KILL、quarantine 和恢复。`/ps` 继续打开原 Host 看最后 record，不自行触发恢复：

- containment 完成且无错误：`Processes · runtime contained`。
- cleanup 未 settle：`Processes · containment in progress`。
- cleanup 失败：`Processes · runtime cleanup incomplete`，并说明未收敛 group 数和 process 调用暂被拒绝。

panel 打开期间，title/hint 随状态变化。未收敛 group 保持 live，因此仍显示 running；已经确认清理的 record 显示 `crashed · runtime-contained`。列宽不够时，UIKit 将整个 list 换成短形式 `crashed` 并保证不裁断；本包只提供完整 `status` 与 outcome `statusShort`，不自行量宽。完整 cause 始终在 detail 的 `Status:` / `Cause:` 行。

Supervisor 不在时，identity、完整 command 与 status 仍来自本地 record。只有 log 需要 Supervisor：正常时保留简洁 metadata，只加 watch 聚合行（无 watch 就不加）；log 获取失败时才补本地已知 terminal cause、start/end 时间、PID/PGID，末尾说明 log 不可用原因并留空 output，不让 log 错误顶掉整个 detail。
