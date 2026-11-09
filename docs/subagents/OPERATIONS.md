# pi-subagents · 操作与排障

## 1. 当前运行路径

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0、唯一 SDK；managed native thread UI 支持原版主题降级，补丁宿主提供主题热更新，见 [UI_SPEC §5](./UI_SPEC.md#5-主题与终端释放)。Main process 内独立 session/runtime，无 Agent Supervisor/PTY child 或 backend chooser。配置 user<agent-dir>/pi-subagents/config.json、trusted project<cwd>/.pi/pi-subagents.json，schema 2。数据<agent-dir>/pi-subagents/store-v2/mains/<mainKey>，diagnostics 按 package closed layout。日常 Pi 与迁移 profile 分开 agent-dir；均从各自运行环境/公开 Pi API 定位，不修改日常 agent-dir 或默认入口。

source-only 依赖已迁入；compiled Subagents 或其 source-only 依赖变更后重建直接 consumer，Subagents 用 npm run build/verify-dist，再 fresh Pi 1.5.0 process。mailbox-v1.0.5 要求相关 compiled consumers 同步新 build，不混用旧 bundle。旧三项 Main append private probe 已退役，适用 consumer 的 probe 仍须验证。source-loaded Side/Compact 不用 build，仍 fresh process。/reload 是生命周期测试动作，不能代替重建验证。

## 2. 生命周期排障

| 现象 | 查看/处理 |
|---|---|
| agent-closed/closing，输入拒绝 | closed 用 resume_agent/R/resume-agent 显式恢复，再单独 send/Enter；closing 等 drain，草稿保留 |
| open-agent-capacity | list/open count，收集结果后 close 闲子树；closed 不计，closing/queued 计；resume 不会自动腾名额 |
| agent-busy | 普通 input 只 steer 仍在运行 Task；停止中的 current 不收 input；需要新工作可 interrupt=true，UI Alt+Enter 另 FIFO |
| activation queued | waiting 输入或 Process continuation 等 active 位；原 Task/依赖/lease/deadline 未变，不重发。正常排队超过 30 秒不能误变 record-only；watchdog/cancel 必须同 Task/generation 收口 |
| cleanup_pending 超过 3 秒 | 仍 closing，检查未响应 tool/prompt/public idle、scope Process cleanup、lease/control ACK；不能硬 kill JS 或伪造 closed |
| frozen unavailable | 核对已登记 factory/hash/model scope/credentials/artifact；不重读 role 扩权或 fallback model 执行，history 可读 |
| native view 因 host-capability 被拒绝 | 核对 UI_SPEC §5 的 SDK export 与 native UI context 两面及 CLI/SDK 装配；缺失/未知时不绕过 guard，Main strip/Tree 与 headless 不受此 marker 限制 |
| config-invalid | 按中文 source/key 诊断移除旧 backend/resident/liveView 键；Main 仍可普通输入，new spawn/send/resume 禁用 |
| unread 不消 | successful view 清自产活动标记，descendant 需点精确卡片；失败 init/receipt/write 保持 unread，close/resume 不清 |

X/Ctrl+C 仅停 current，queued-only 无 current work，不删 FIFO；C 忙关闭须显式 Force close 确认、默认 Cancel。D 对已完成 open 子树先 close/drain，再复核 revision 与 delivery/lease/ACK/prepare 后 delete；未完成工作仍拒绝，不隐式 force，不用 delete 回收 active。close 本身是可恢复 runtime 关闭，不删除 history。不得手工编辑 journal/CURRENT/receipt，无法证明损坏保 bytes 并 unavailable。

## 3. Main 结束与冷恢复

quit/new/resume/switch/fork/clone/reload 都 ending fence 并撤销旧 append/view 权，Host 串行枚举 force-close 全树；异步 prepare/lease/assembly 最终检查 ending，rollback 自身 artifact/lease。quit 不重启 Main TUI。回旧 Main closed、zero auto work，显式 resume 恢复目标 idle 无 Task/lease/provider/compact，再 Enter/send 才新工作。

进程被 kill 后 cold reopen 在单 writer lock 下 replay 完整 commits，unfinished current/queue→interrupted/host-lost，一 Task 一 Completion，Agent closed、旧 input/event cancelled。正常 public agent_settled 才允许 native proof 提取 final/usage；assistant tail 不能证明冷恢复完成。pending Inbox/Outbox/Wake receipt 续对账不重跑模型。重复/冲突 ID/hash 按 Persistence/Delivery 处理。

## 4. profile 与旧存储边界

新代码只用独立 store-v2，没有 v1 reader/converter、封存浏览器或启动删除。旧存储不读、不转换、不删除，不能把本轮源码迁移当作旧数据清理授权。

1. 记录运行环境实际解析的 agent-dir、commit/build/binary/profile hash；使用隔离 profile，不做 global PID pattern 清理。
2. 在隔离环境更新 schema 2/移除 backend env，重建 compiled consumers 后 fresh process；不改旧 store、auth/Main history 或其它 package 数据。
3. 验证 spawn→close→closed send 拒绝→resume 零请求→send→Completion；quit/new/switch/reload 全树 closed，回旧 Main 无 auto work。旧 Main transcript card 只是历史，旧 ID 不自动重建/执行、不入新 Running/Done。
4. 回退先停本次新 writer，只切换隔离环境的 code/build/config，不让新旧代码交叉写存储；正式 profile 切换另排。正常 close/resume 永远保留 v2 history。

本文件同步未运行删除或正式 profile 切换。旧 card target not found 不代表旧 store 已删除；当前代码不读取它，也不提供专门 legacy-ID 迁移 diagnostic 或重跑旧任务。

## 5. 验收与诊断记录

以下是待执行的 gate，本轮文档修订不运行 build/测试/安装。先核心 typecheck/build/verify-dist/unit/contract、stock probe、适用 real SDK/TTY/faux；再共享 node scripts/check-dependencies.mjs/command gate/diff-check。report 列 actual commit/binary/profile、gate output 和未测。historical process/RSS 数字不抵当前 Pi 1.5.0 与 patched UI host 基线：完整 profile/10 并发 32 open 长 history/20close-resumecycle、heap/handler/FD/timer/p95 按既定门槛重测，不强制 GC 掩盖残留、不以离散 max 冒充峰值。

真实 provider 只按 coordinator 批准的小模型预算，faux 用于大控制流/容量矩阵；native TTY 非真实模型请求。真实 provider、全 profile、人工 TUI 与规模性能仍未验收；IME/physical kitty/SSH 人工验证单列。cleanup 只处理本次自起 process/temp 目录，不改他人 store/profile/auth/日常 checkout。
