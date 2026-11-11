# 会话 mailbox 合同

Scheduler 使用共享库 [`pi-session-inject/mailbox-v1`](../../pi-session-inject/docs/mailbox-v1.md)，producer ID 为 `pi-scheduler`，key 为 `injection:<injectionId>`。保留原 injection ID、SHA-256 校验、`scheduler-injection-v1` customType、content 和 details，mail 使用 `policy=new-run`、`wake=true`。

共享库拥有投影、wake、cold recovery hold 和 `/mailbox`；Scheduler 不自行发送 live carrier 或 native trigger。任务、迟到、占用、daemon 状态和业务记录仍归 Scheduler。无人持有的离线执行仍走 `pi --print`，不把已有 mailbox intent 改回离线执行。

## 持久 source 事务

extension 在异步 IPC 前捕获 `endpoint.target(ctx)`；后续操作固定原 session/injection，旧 binding 不得投给替代 session。daemon 占用还核对唯一 live holder 的 PID、token、generation。

| 请求 | 持久结果与保护 |
| --- | --- |
| `injection.offers` | 核对唯一 holder。只有明确未 append 的 pending 可冻结当前 leaf 为 origin。旧 settled、append-uncertain、uncertain-lease 必须提供原 native carrier 的 ID/content/details/entry ID/parent scope，保留原 phase 和 proof；缺失或冲突只显示 unknown，不重锚、不重发、不猜过期取消。新 reservation 落盘后才回复，重复请求保留 exact mail。 |
| `injection.current` | 只读原 marker 和 daemon 时间。marker 缺失时，旧 delivered run/永久 legacy receipt 只能授权 exact proof 导入，不能授权投影/wake。source 缺失、冲突或 I/O 错误保持 hold；首次 start 前 `now > staleAt` 取消。 |
| `injection.handoff` | 仅 awaited `onRecorded` 在 mailbox 持久接管且 native proof 完整后调用；提交 `phase=mailbox-owned`、原 recordedToken 和 entry ID，不制造 delivered 记录。同 proof 幂等，冲突拒绝。 |
| `injection.start` | 只有真实 `beforeRun` member 标记首次开始；已开始工作可以晚于 staleAt 完成，ACK 修复不合成此 callback。 |
| `injection.failed` | 只有真实 `afterRun` member 的 aborted/error 结果记录失败 intent，再 await 取消同一 mailbox key。取消失败时后续 guard 读取失败 intent 再取消，不自动重试；unknown/crash 不伪造错误结果。 |
| `injection.terminal` | awaited `onTerminal` 核对稳定 fulfilled/cancelled evidence 和 source scope。fulfilled 必须已有 handoff/native 及共享库 assistant/receipt 证据；cancelled 记失败。永久 source receipt 先于历史记录和 marker 清理提交。 |

`offers` 不抢仍有效的 legacy append lease。带 mailbox intent 的 marker 不允许旧 `poll/ack/nack` 分发或结算；daemon 重启、lease 超时、drain、会话空闲或时间流逝都不令其返回离线路径。初始 marker 按原顺序推进 watermark，active marker 阻止同任务重叠。

新 occurrence 冻结创建时唯一 holder 为 `createdForHolder`，只向完全匹配身份发 live offer；旧格式、legacy carrier 和替代 holder 都属于恢复。此分类跨 daemon 重启保持，不能从请求 offer 的 holder 反向补写。恢复用 `endpoint.put(mail,target,{recovered:true})`，即便只有 source intent、没有 mailbox snapshot 也保持 hold，直到可信输入或 `/mailbox resume`；原 holder 新工作用普通两参 put。`importFulfilled` 和零请求 ACK 修复不改变。

存储采用 temp write、file fsync、rename、directory fsync。坏 marker fail closed，不能从 planner 的 active 集合消失；`mailbox-owned` 必须有有效 native/recorded proof，不往 native details 加新字段。

`mailbox-receipts/<encoded-injectionId>.json` 保存最终原 evidence、冻结 marker、稳定 terminal ID、history commit flag，独立于可清理的人类运行历史。回复丢失或历史过期不能制造第二次终态/执行；history 写前写后崩溃均由同 receipt 修复。inventory、normalization、runtime reconcile 共用身份检查：task/injection/session/scheduledTime/prompt/title/staleAt、原 anchor 和已知 native/recorded proof 必须一致，允许 phase/lease/start 正常推进，冲突在归档或清理前拒绝。

mailbox fulfilled 沿用 `delivered` outcome、detail 为 `mailbox-fulfilled`，只证明成功请求机会，不等于业务成功。cancelled 沿用 `failure`、detail 为 `mailbox-cancelled:<reason>`。两者都不重跑任务。

## Legacy 导入

只读原 active branch。具有完整冻结 daemon intent 的 pending、过期 leased、append-uncertain 成为同一逻辑 mail。旧 append-uncertain/append-only settled 即使过期也保留 payload，启动不能在 importer 前抹掉证据；原 carrier 不可见仍是 unknown，不能以缺席推断重发或取消。过期 lease 变 proof debt，不恢复离线执行；有可靠 source scope 后才按原 stale guard 处理。原 native proof 提供原 parent anchor，Scheduler 不再创建第二条正文。

已存在成功处理证据时调用：

```ts
endpoint.importFulfilled(mail, { sourceReceiptEntryId, assistantEntryId }, target)
```

sourceReceiptEntryId 使用原 native carrier entry ID。共享库独立验证身份、正文、branch、成功 assistant 及中间 context edit/compaction。无 marker 的 legacy key 首次认领前，Scheduler 必须有 exact 旧 delivered run，且同 task ID 的有效 `validateTask` session target 等于请求 session。fork 继承的 carrier 不授 source ownership；缺任务、坏任务、非 session 或目标不符都显示 unknown，不写 source receipt。daemon 在首次 recorded/terminal 写入前再次核对。

永久 receipt 提交后可在任务删除/历史清理后重放 ACK，其他 session 不得替换 scope。无 marker 的 recorded ACK 先 fsync 原 RecordedNotice 到 `<id>.legacy.json`，最终 ACK 再加入 fulfilled evidence；即使 recorded 回复丢失后历史被清理也可修复。重复 terminal 不新增 run/marker。

recorded-only legacy debt 必须列出并拒绝回滚投影，不能猜缺失字段来放弃；缺冻结 job 身份的 minimal receipt 不能完成恰好同 ID 的 active marker。缺 intent 或成功 proof 保留原 source 并可见告警，不从当前可变任务重建相似 prompt、staleAt 或 job。新 mailbox 完成记录不再作为 legacy 导入。

## Scope 与缓存

target 在 source IPC 前捕获，同一冻结 mail/target 保留至异步完成。tree 导致未 accepted put 失效时保留 source intent；后续 sibling poll 不可直接采用新 target。原 leaf 或 exact carrier 必须正向证明 scope 后，才可用同 mail/key 在新 generation 对账。已经 accepted 的工作沿用共享库持久保存的旧 branch admission anchor。取消使用原 callback fence，不因迟到 tree 改投。

live intent cache 只在原 source 持久 ACK terminal 后释放（包括 onTerminal 重放和 terminal put 返回）；丢回复保留，确认重放幂等删除。retire 清理 binding cache。未 accepted/stale intent 不按 TTL 或容量淘汰，防止历史清理后不安全改投。

## 离线回滚

仅在需要退回不识别 mailbox 元数据的旧 Scheduler、或明确维护 source 投递数据时使用。**先停止该 profile 的所有 live Pi 和 daemon，并阻止服务自动重启**；工具不停止服务、不改 profile。工具取得与 daemon 相同的 kernel advisory lock，活跃 daemon 持锁时拒绝。

本工具只负责 Scheduler source store 投影，**不是共享 mailbox 的整批回滚命令**。操作前另行清点该 profile 的 mailbox pending/terminal、原生 control/receipt；不得只删 source 就宣称撤回已提交的请求。放弃未完成工作需用户对每个 exact injection ID 明确批准。备份并保留原共享 mailbox 与 session 数据，不让旧、新消费者同时接管。

在仓库根（Node 24）运行：

```sh
node --import ./ts-resolve.mjs local/pi-scheduler/scripts/mailbox-rollback.ts \
  --store /absolute/agent/scheduler --check
node --import ./ts-resolve.mjs local/pi-scheduler/scripts/mailbox-rollback.ts \
  --store /absolute/agent/scheduler \
  --archive /absolute/outside-store/archive \
  --abandon 'exact-task-id:scheduled-time'
```

`--check` 验证所有 receipt（包括没有 marker 的），列出 unfinished injection，存在 blocker 时非零退出。损坏 receipt 拒绝投影；已提交但未写历史的 receipt 在 mutation 时补齐旧格式记录。mutation 必须逐项 `--abandon`（可重复选项），缺失、未知或重复 ID 在修改前拒绝；只有完成 receipt 则无需放弃参数。

工具先逐字节归档 store 并同步磁盘，归档目录必须在 store 外且尚不存在；再把明确放弃的投递记为旧格式终态失败 `user-abandoned delivery`，保留 injectionId 和已有 job 结果、推进欠缺 watermark，删除 active store 的 mailbox metadata/receipt 目录。已完成 receipt 保留原 fulfilled/cancelled outcome，归档写入 audit manifest。它不伪造 delivered ACK，也不保证跨 source/shared transport 的原子撤回。修复或恢复时使用归档原字节和 audit，对照共享 mailbox/session 证据处理，不能把归档混入运行中的目录。

## 验证边界

`npm run test -w pi-scheduler` 覆盖 source callbacks、真实 daemon IPC/SIGKILL、commit/ACK 丢失窗口、stale/start/error/cancel guard、旧 carrier 导入、严格 marker 读取、rollback CLI 拒绝/锁/归档，以及用[冻结旧 reader](../tests/fixtures/README.md)读取投影结果。final ACK stand-in 属于本包，只使用 mailbox 公开 DTO，不 import 其他包的测试代码。

`npm run check:host -w pi-scheduler` 从源码构建，使用根 runner 的 `PI_BIN`（缺省根安装的 CLI）并核对 SDK 版本。依次验证：

1. Node CLI 无 `PI_SCHEDULER_BINARY` override 的真实自动启动；用 faux 执行一次 agent 定时任务。
2. 新 stock Pi 中 source callback + daemon IPC 的终态幂等修复，零模型请求。
3. 真实 mailbox transport + Scheduler source/daemon 的完整宿主矩阵：final/recorded ACK 丢失、ACK snapshot 写失败、禁用 source、cold/source-only hold/resume、live idle、批量合并、peer owner 顺序、beforeRun late ingress、error/abort、unknown SIGKILL、recorded in-flight 取消、legacy 正负 proof、tree race、switch/reopen 与 fork/return。

恢复 fulfilled debt 必须零请求，正常投递只一次；重复 native proof 保留 pending，不发空 control。owner peer 是共享库测试 stand-in，不冒充 Processes/Goal/Subagents 集成。

矩阵在打印的临时 artifact 目录保留事件、RPC、receipt、history 和 snapshot；可在测试脚本直接调用时用 `SCHEDULER_JOINT_SCENARIOS` 缩小范围、`SCHEDULER_JOINT_ARTIFACT_DIR` 指定空目录。它们只属于测试 harness。自动入口隔离 HOME/agent/cwd，使用 faux，拦截系统服务管理与通知；进程 SIGKILL/I/O 注入不证明断电级 Pi session fsync、真实 provider、完整 profile 或人工终端。
