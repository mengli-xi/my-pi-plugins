# mailbox-v1 · 冻结接口与 A1 运行时

本文件对应 `design-agent-mailbox.md` 第 3 轮 §4.2–4.5、§6.1、§7–7.1、§11。
**A0 冻结接口，A1 实现持久接管、原生投递、可重放通知与稳定命令。**
producer、迁移和回退 gate 全部通过后才允许启用完整 profile；本包测试不替代 full-profile gate。
旧 safe-append API 保持原状，迁移 producer 不得把它当 A0 的运行时 fallback。

## 入口与用法

生产绑定使用轻入口 `pi-session-inject/mailbox-v1/light`，只加载常量、同步身份/生命周期和命令壳。
原完整公开入口 `pi-session-inject/mailbox-v1`（根入口也 re-export），schema 可单独从
`pi-session-inject/mailbox-v1/schema` 读取。无新 runtime 依赖，无 build step，无 extension factory。

```ts
import { bindMailbox, type ProducerRegistration } from "pi-session-inject/mailbox-v1/light";

const registration: ProducerRegistration = {
  id: "pi-scheduler",
  checkCurrent: async (mail, point, fence) => ({ kind: "allow", project: true, wake: true }),
  proveNative: async (mail, branch, fence) => ({ kind: "observed", entries: [] }),
  onRecorded: async (notice, fence) => { /* await source 的幂等持久 handoff */ },
  onTerminal: async (evidence, fence) => { /* await source 的幂等最终 ACK */ },
};
const binding = bindMailbox(pi);
const endpoint = binding.registerProducer(registration);
const target = endpoint.target(ctx); // 在异步 source 工作开始前捕获
const result = await endpoint.put({
  producer: "pi-scheduler", key: "injection:" + injection.id,
  anchorEntryId: ctx.sessionManager.getLeafId(), policy: "new-run", wake: true,
  messages: [originalFrozenCarrier],
}, target);
if (result.kind === "terminal") { /* 已 fulfilled/cancelled，不能再次发送 */ }
```

示例中的空 native observation 只演示类型；真实 adapter 必须校验自己既有 ID/hash/content，
返回该原 branch 的匹配 indexes 或明确 conflict。A 合并自己的 live submitted，空 proof 不授权重发。
`messages` 非空，carrier 支持原生 string 或 text/image 数组；`details` 不加公共 mailbox 字段。
所有输入必须是有限数值的 plain JSON；拒绝 undefined 属性、BigInt、非普通对象、循环和有损序列化。
数组也核对 own keys、prototype 和元素 descriptor，拒绝稀疏/装饰数组、隐藏 toJSON/accessor，不执行自定义 iterator 或 getter。
source 私有 identity 与 payload 等价规则保持原状；同 key 换正文、policy、wake 或 origin branch 都冲突。
`anchorEntryId=null` 只允许尚无 entry 的空会话。

ProducerId 是 `MAILBOX_PRODUCER_IDS` 的六个公开值；同包 Main/Side/child 共用 ID、分别使用 session slot。
policy 只有 `MAILBOX_POLICIES` 的三值，不新增 TTL、priority、通用 authority 或 request 查询服务。
`target(ctx)` 同步核对当前 public SessionManager identity；异步 producer 必须传捕获的 target，
防止旧动作误投后来的 session。省略 target 的 put/cancel 在**调用时**捕获当前绑定，之后不随 await 改投。
target 不含 ownerEpoch：正常 peer 接管不使 producer intent 失效；所有 callback fence 另含当次 ownerEpoch。
mail.producer 必须与 endpoint.id 相同。关闭/过期 target 拒绝，不能转发到 Main 或新 Task。

legacy/恢复 pending 的 importer 使用 `endpoint.put(mail,target,{recovered:true})`，即使此前没有 A snapshot。
第三参是协调者批准的可选 recovery admission，不改变冻结 mail 或持久 schema；普通新邮件仍用两参。
A 在该 key 首次 acceptance 的同步事务段登记 hold，再允许调度。已经在本进程正常 accepted 的 live key
遇到 tree 返回/Host 重绑的 recovered 重放不重新 hold；可信 accepted interactive/rpc 输入或
`/mailbox resume` 已释放后，晚到 importer 也不重新 hold。source 不需要保存一个永久 hold guard。

## 同步、异步、异常与重放

协调者批准的 A1 最小增补：`endpoint.importFulfilled(mail,{sourceReceiptEntryId,assistantEntryId},target?)`
供所有 source 导入 legacy fulfilled。source 解释旧业务 receipt；A 独立验证同 origin branch 的磁盘
source receipt、成功 assistant、原 native carrier，再写公共 receipt/terminal，零模型请求。
旧 Scheduler/MC 无独立 source receipt 时可填该 mail 自己的 exact native custom carrier ID。
缺任一证据保留 visible-unknown，不能猜 ID；新的 proof 形式仍须接口 owner 与协调者批准。
协调者批准 pending 的可选 `legacyImport:{proof,evidence}`：先把导入意图、requiredCallbacks 和
完整 recorded notice/token 同 snapshot fsync，再写 receipt，最后转 terminal。evidence 尚无
receiptEntryId（由后续 public append 生成）；导入中 pending 永不投影/唤醒。恢复复核原 carrier/
assistant 后补唯一 receipt，保留原 terminalId/recordedToken，再补 ACK。已正常 GC 的历史 receipt
不重新制造通知债。有/无预先 pending 两种路径均覆盖真实 SIGKILL。
旧 Goal user continuation 不经过此 importer：C 在 source 侧核验成功并清 owed，缺证据由 source 列 visible-unknown；
A 的 importer/runtime 都只认 exact custom carrier，不为 Goal 放宽为任意 user entry。

真实 before_agent_start 先 await participant admission，再取最终 ingress 上界并 seal；
producer.beforeRun 中 await put 的消息可加入同次已接受用户 run。每个 participant 固定 5 秒上限，
抛错/超时按 hold+diagnostic，不无限推迟 run；超时后的 put 是 successor，不能偷入旧批。
这细化了原 §6.2 的封存顺序，不改变 callback 参数。源侧冻结 mail 的 durable intent 仍由 source 保存，
没有公开读取 Mail 的查询服务；B 可用独立 model-invisible process-notification-intent-v1 保存其原 intent，
不得修改原 batch content/details 或自行决定 native 重送。

协调者另批准 `endpoint.activateNewExecution(target):Promise<void>`：只允许已注册的 pi-subagents
execution-owner token 在本进程新建 SDK execution 的首个真实 run 前调用，且不能是旧 snapshot 恢复。
它保留 execution-owner 的显式校验，不创建 control，也不授 Task/grant 权限；调用方仍须取得首个 Task grant。
已有真实 run、恢复过的 slot、其他 producer 一律拒绝并 diagnostic。cold hold 只作用于本进程首次
恢复出来的旧 pending key；本进程新 accepted key 直接 live，因此 startup 的 /goal kickoff、Side 的
extension prompt 和 Main 新卡片都无需额外 source 通知入口。D 可继续显式调用这个兼容入口。

`bindMailbox`、`registerProducer`、`target`、`close` 同步。bind/register 只建轻量 lifecycle bridge；
session_start 只轻量探测当前 session 目录；有恢复/崩溃后清理工作才加载重存储/加锁/读 session 证据，新空 slot
延至首个 mutation 才建 writer。历史 orphan 扫描仅在 recover 命令/候选入口触发，按目录 single-flight，
put/cancel/GC 只失效缓存而不重扫。没有有效 session_start 的发送报 not-ready。
lazy writer 打开失败不缓存 rejection；修复文件权限后同 binding 可重试，失败后无已取得 writer 的
barrier/close 不复用旧 rejection。每次首次打开或空目录清理后重新取锁读到的旧 pending 也先登记 hold，因此轻量探测后
另一个已退出 writer 写入的 pending 不会被本进程下一封新 mail 顺带唤醒。
put 在同步 ingress 克隆冻结 JSON 并取得事务序号；async 工作不在调用后读取可变 source carrier。
close 只 release 自己的 registration，已登记事务仍完成原文件事实，不允许影响 replacement。

`put`、`cancel` 返回 Promise；同 slot 串行，temp write → file sync → rename → directory sync 后 resolve。
put 返回 accepted `{key,revision}` 或 terminal `{evidence}`，不等模型、onRecorded、onTerminal。
put/cancel 的 resolve 路径也不 await checkCurrent、proveNative、beforeRun、guard 或任何 source ACK；
Host 在撤权事务内 await cancel 不会反向等待 source。importer 的 source proof 在 terminal 序列化之外执行。
重复 accepted 返回首次 acceptedRevision。cancel 写同 snapshot tombstone 和通知债后 resolve；
unknown-key 拒绝，已有任一终态返回原证据，第一份持久终态获胜。cancel 不是 source 取消 ACK，
也不能撤回已提交 native queue 或已经冻结的请求。I/O 错误 reject，不能先删最后副本。
持同 writer lock 时复用已验证的内存 snapshot，成功写入后更新；每次以 metadata 检查外部变化，
重获锁或 uncertain-write 必须重新读盘。SlotStorage 不在取得 writer 锁前重复读取同一 snapshot。
Session JSONL 的解析和 entry 索引按 identity 合并并发、只保留最新版；每次核对当前文件版本和 session identity，
追加/替换/截断或读取失败后失效，binding 退役释放。读取前后同时核对打开 inode 和路径的 dev/ino/size/mtimeNs/ctimeNs，
不靠解析 cache 代替 native readback、writer token、业务 guard 或 fsync。

每个 callback 都允许同步返回或 Promise，均 await；同步 throw 与 reject 含义相同。
callback fence 固定 `{slotKey,session,bindingGeneration,ownerEpoch,producerToken,attemptId}`，
自然 run / 通知重放没有 attempt 时为 null。await 后重新验证 scope/binding/branch 与 token；
迟到 callback 只能完成已经开始的原 source 事务，不能 ACK 新注册、释放新 attempt 或发 wake。

| callback | 调用、异常、重放 |
|---|---|
| checkCurrent(mail, point, fence) | 只读 source 决策，不创建 fallback intent；point 限 before-seal/before-native-send；返回 allow/hold/cancel。throw 视 hold+diagnostic，不伪造 cancelled。wake 不能越过 project=false。cancel 走 durable cancel。 |
| proveNative(mail, branch, fence) | 输入原 active branch 的公开 SessionEntry；observed.entries 可不全，conflict 明确阻塞。throw 保留 unknown，不转 absent；部分 proof 不发整批 ACK。 |
| onRecorded(notice, fence) | 全部 carrier proof 一致后先 fsync notice，再在 writer 锁与 lifecycle critical section **之外**调用；只等待本 mail 的 native 事实被 source 幂等持久接收；不能等 sibling、完整业务交付或未来成功轮。相同 recordedToken 重放幂等。 |
| onTerminal(evidence, fence) | 先 fsync evidence，再在 critical section 之外调用；只确认本 mail 的 fulfilled 机会或 cancelled 撤销事实被 source 接收，不等待业务 turn settlement。只有 fulfilled/cancelled；同 terminalId 重放不叫模型。 |
| beforeRun(start) | 仅真实 before_agent_start；给当前 ctx/event、该 source 获准的 members/原 mail marker、automatic 和 fence。每个存活 participant 都接真实事件，即使 members=[]；Goal 自己判 marker/manual accounting。throw hold 未承诺工作；不能撤销 control。 |
| afterRun(end) | 仅真实 agent_end，含 outcome、实际 request 观察的 members、可用 assistantEntryId/native proof。throw 由 source 保留业务 settlement 欠账并 diagnostic，不回滚已 fulfilled。 |
| settled(event, ctx, fence) | 先更新 transport fence，再分发真实 public aborted/ctx。throw 保留 source intent；不保证其它 extension handlers 全部结束。deferred 批次在它自己的 before_agent_start 才封存。 |

只有 onRecorded/onTerminal 是持久通知重放；其余回调只用于真实 guard/proof observation 或真实生命周期，
不能合成 beforeRun/afterRun/settled 来补 ACK、推进 Goal iteration 或伪造 Task settlement。
没有某 ACK callback 才能将该项记成不需要；acceptance 时冻结 requiredCallbacks，disabled/close 不改变它。

同 key fulfilled 先补 recorded 再 terminal。即使 onRecorded 失败但请求成功，也可以持久 fulfilled，
其 recorded debt 随 terminal 保留。cancel 用 onTerminal 收口；未开始的 recorded 重试在同 cancel snapshot
标 superseded-by-cancel，没有完整 proof 不制造 recorded notice。已执行中的 recorded 可完成原事务，随后幂等取消。
callback 成功后复核 token/epoch/id，A 再 fsync ACK；source commit 后丢回复或 A ACK 落盘前 crash 都重放原 token。
通知只因新 recorded/terminal 事实，或 attach、显式 resume、真实正常 lifecycle 恢复边界调度。
同 key 同 payload 的 put 仍请求 guard/proof 重查（例如 child grant），但不重放 recorded/terminal；
无变化 reconcileProofs、schedule 收尾、重复 cancel/import 都不无条件重放旧债。callback 失败只保留债和本次诊断，排空后等待新事实。
attach 先等待 acquire/rebuild ready 屏障，再独立调度通知与投递，**pending=[] 也补终态通知**。
不存在按整 producer ACK 债清零的 attaching 门闩；坏 key 不阻塞健康 key。per-key recovery-held 和所有 branch/fence/guard 继续生效。

事实分三层：recorded ACK 证明 source 收到原 native carrier；fulfilled 证明该 carrier 获得一次成功 assistant 请求机会；
producer 自己的 owner 级成功证明才确认业务已完成。三者互不替代；成功 toolUse 后整轮 abort 的 receipt 不能完成业务结算。
source 业务成功或人工已读也不是 A 结束通知债的证明；Subagents Main 的原 Inbox 仅在已读、业务退休且 A snapshot/精确磁盘 receipt 证明相关全部 key 已 ACK/GC 后，才可在 checkpoint 回收，涵盖升级 checkpoint、import/cancel 与 recorded/terminal ACK。公开 holder/slot 的 terminal 可证明 handoff，不能单独证明已 GC；snapshot 缺席仍需 receipt 见证。

## snapshot、终态与 GC

`MAILBOX_PENDING_SCHEMA_V1` 是 draft 2020-12 exact schema；对象默认拒绝额外字段，details 为递归 JSON。
类型 `MailboxSnapshot` 与 schema 对应 `<agent-dir>/mailbox/v1/<session-id>/pending.json`：
session(id/file)、revision、suspended、pending、terminal，以及可省略的 sealed attempt。
session.cwd 是获批的兼容可选字段：A1 总是写 public ctx.cwd，A0 shape 仍可解析；缺文件又缺 cwd
不能猜原项目。recover 要求与当前 public cwd canonical 等价，否则展示原目录并保留 pending。
acceptedRevision 固定原 acceptance；branchEntryId 保存实际 origin lineage，与冻结 mail.anchorEntryId 分开。
跨进程 lock 不是 pending schema；同一 session 单 writer，活 PID/token 拒绝第二 writer，不以 TTL 抢占。

pending 保存完整冻结 mail、requiredCallbacks、部分 nativeEntries，以及完整后才有的 RecordedNotice/ack。
terminal 保存原 mail、稳定 evidence、recorded 债、terminalAck 与可空 backingReceiptEntryId。
ack=pending 对应合同的 recordedAckPending/terminalAckPending；acknowledged 必须已 fsync。
superseded-by-cancel 只允许在 cancelled terminal 的 recorded 中，pending/fulfilled 禁止。
即使物理 pending 尚在，terminal 也总是优先，永不再次投影/唤醒。

TerminalEvidence 在首次持久生成后保持逐字段不变；TerminalToken 就是 terminalId，无第二套状态 token。
取消后新增 receiptEntryId 只写 backingReceiptEntryId，不修改已通知 source 的证据。
fulfilled 必须先验证正确 session 磁盘 delivery entry 与成功 assistant，然后同 snapshot 加 terminal、删 runnable pending。
新空会话没有 Pi 文件时，fsync tombstone 本身有效，不能因 receipt 尚在内存而 GC。
终态索引唯一持久证据缺失/矛盾时报 unverifiable-proof，不能当 absent 再 accepted。

只有 source durable commit → A durable ACK → 验证正确 session 磁盘替代 receipt → snapshot GC。
source disabled、close/reload、时间或 sibling branch 看不见 receipt 均不允许 GC。
磁盘 delivery receipt 保留 scope/key、terminalId、原冻结身份材料；GC 后按它重建同一终态并验证重复 put 冲突。
GC/attempt 收尾的事务若已无 pending、terminal、attempt 或 suspended 状态，会持 writer 锁删除
`pending.json` 并同步目录，再核对 owner token 释放锁、只删除空 session 目录并同步父目录。
该清理仍在同一事务队列内；之后的新 put 必须重新取锁、重读磁盘。取锁时目录若被并发清理，
mkdir/symlink 最多重试八次，不允许无锁写入。竞争 writer 已新建的文件会令 rmdir 拒绝删除。
文件/目录不存在与空 snapshot 等价，既有 key 的终态仍从 session delivery receipt 返回，新 key 正常重建。
欠 ACK、disabled source、无法证明的 pending、sealed attempt、suspension 或目录内其他文件均不被清理；
没有 timer、全库扫描或按时间删孤儿数据。崩溃遗留的当前 session 空目录在 attach 时持锁收尾。
`MailboxDeliveryReceipt` 的 fulfilled evidence 不嵌自己尚未知的 receiptEntryId；读取时用外层 Pi entry.id 补回。
这是 public appendEntry 生成 ID 的编码细节，不改变 source TerminalEvidence。terminal index 不扫 sibling 假造完成。
稳定 key 不复用；删除终态索引只有合同规定的显式整批归档/放弃维护操作可以授权。

JSON schema 只校验结构。A1 parseMailboxSnapshot 还必须核对唯一 key、session/origin、mail/evidence 一致、
messageIndex 覆盖/唯一、callback requirement/ACK 顺序、terminal precedence 和相互引用，不能把 schema 合格当 native proof。
普通 pending 的 nativeEntries 与 recorded notice 按 messageIndex 核对同一组 entry IDs；fulfilled evidence 的
nativeEntryIds 还须与 recorded notice 的索引顺序相符，不向 source 重放内部矛盾的通知材料。

## holder、三类 submitted 与命令 facade

holder ABI=1，transportBuildId=`mailbox-v1.0.4`（投影拒绝/异常闭合、校验和读取状态复用；旧 compiled consumer 必须重建并新进程启动），key=`pi.session-inject.mailbox.v1`。
轻/重引擎的布局和 recovered 第三参要求匹配的 runtime；因此新旧 compiled bundles 混用
必须明确拒绝，而非接入旧 holder。schema/ABI 仍为 1；整批 compiled consumers 须 rebuild 并 fresh process。
现有 holder 的 version/build/方法必须一致，不能覆盖。只有全局属性真正缺席才创建；已有 own undefined、
accessor 或 inherited 同名注册均报 holder-incompatible，不执行 getter/setter。transport、engine 和 readonly reader 使用同一规则。
轻入口不静态加载 engine/commands/schema/proof/storage。重引擎由
`Symbol.for("pi.session-inject.mailbox.engine.v1")` 保存单个加载 promise 与 namespace，连同模块导出的
ABI/build/方法一起校验；并发的 extension/SDK session 复用同一 promise，失败不缓存 rejection。
第一次 put/cancel/真实 run、导航、恢复或命令才激活。激活只把库自己的 cold methods 安装到既有 slot
对象上，不创建第二套 authority，也不改 Pi prototype；generation、epoch、token、submitted 与 ingress
始终属于原 slot。有 snapshot 时 session_start 仍 await 引擎和恢复，不能拖到首次用户输入后。
`/mailbox` 在启动阶段同步注册；静态补全与重 parser 共用 `MAILBOX_COMMANDS`，recover 的动态候选由
命令/补全手势触发加载，尚未 ready 返回 null。Goal 的 Bun build 保留真实动态 chunk，并优先复用共享 namespace。
slot key 为 `JSON.stringify([canonicalAgentDir,sessionId])`，另核对 sessionFile/公开 SessionManager identity。
binding generation 由退休 slot 的首次 session_start 递增，其余 consumer join；owner 选举才加 epoch；
producer 每次注册用独立 symbol token。owner 关闭时卸载自己的 core hooks，由最早 live peer 接管。
协调者批准的 branch fencing 细化：每个真实 session_tree 由唯一 owner 只递增一次 bindingGeneration，
重置 input candidate，owner epoch/producer token 不变。这样 tree 前捕获、尚未 put 的异步 target，
即使 anchor 是 sibling 共享祖先也会 stale。source 收到 stale 后保留原 durable intent，不能在 sibling
盲目重新捕获 target/改 anchor 或换 key 重送；等 source 自己验证原 origin/Task/guard 后，在正确 scope
重新捕获 target 并用同冻结 mail/key 对账。已开始的 ACK 事务仍可完成原事实，由稳定 token 后续重放收口。
最后 producer 关闭也不清 pending、通知债或 live submitted；shutdown 等原事务完成并 retire fence。

三类提交分别保存为 `LiveSubmitted.falseBodies`、`activeControls`、`idleControls`。
falseBodies 只由本 carrier 的 branch/identity/content native proof 正向确认；active control 只认自己
sessionId+attemptId 的 message_start/end；idle/deferred control 只认自己 before_agent_start。
确认 start 不等于成功处理，只有该 attempt 对应真实 run 收尾才能释放占位。
absence、超时、其它成功 run、isIdle、pending count、clear_queue 都不证明旧队列消失，不能重送。
同进程 owner handoff/reload 保留三类 facts；只有 fresh process 可按旧队列已消失重新对账，且先 recovery-held。
hold 按恢复的旧 pending key 保存，覆盖 ready、lazy open 和显式 recovered admission；本进程正常
accepted 的 live key provenance 在同进程 reopen/reload 保留。重复 put 旧 key 不解 hold；新 key 可唤醒时，旧 carrier 仍从 context
过滤且不可被顺带 fulfilled。可信 accepted interactive/rpc 输入或 /mailbox resume 才解除旧 key 的 hold；
streaming/handled/ambiguous/extension 不解，也不解除 Goal pause/Task final/过期等 guard。stock Pi 的
slash command 在 input hook 前 dispatch，不能从 command ctx 猜 source；按协调者裁决不增通知接口。
Side view detach 不是 reopen。

proof conflict/unknown 与 guard 错误分开保存；guard allow 不清 proof 错误，坏 key 不得授权 control，
其它健康 source 仍可推进。每次请求都重新检查 guard，包括已经 recorded 的 pending；hold、cancel、project=false、
guard 异常或 participant-held 都不能因正文已在 native history 就绕过过滤。cancel 决策仍须 durable cancel。
共享 carrier 只要还有合法 live/fulfilled reference 就保留，不误删历史或其它合法 key；拒绝只影响本次 projection。
投影异常用公开 ctx.abort() 停止对应操作，并清空本轮可见列表；仅 throw/notify 会被 Pi 报告后保留原 messages，不能当 fail-closed。
迟到回调不 abort signal 已变化的新 run。每次异步 guard/proof 后及不可撤回 enqueue 前，同步核对最新 snapshot 的
pending/terminal、冻结身份、branch/fence。cancel 不等待这些 callback。公开 turn_end 已有 tool result/
continue 时先只 append，交自然下一请求消费；到 before-settle 仍欠机会才补 control。已被当前请求观察的
成员不再授权第二条 control。原生队列中已经提交的 control 仍不能单条撤回，空 beforeRun 也没有公开
无模型 disposition；source 不得在原工作已被消费后创建无业务必要的 successor。

`MailboxCommandRouter` / `MailboxCommandFacade` 冻结稳定路由接口；bind 负责安装，不让 producer 各自注册。
每 runner 的首次 session_start 用公开 getCommands inventory + registrar provenance 在同一同步段去重注册。
未知 mailbox 同名或 mailbox:n collision fail closed。handler 用本次 command ctx 路由当前 slot/owner，
不捕获 first owner ctx/epoch。command registrar 与 delivery hook disposer 分开保存；owner.close 不重注册命令。
真正完整 reload 的新 runner 才重建 facade；不能用一个 process-global boolean 跨 runner 去重。
completionScope 只保留 facade 自己当前 session 的纯 key，无 owner/数据未 ready 时返回 null。

grammar 只有 `MAILBOX_COMMANDS`：`status`、`resume`、`recover <session-id>`。
parser 和 getArgumentCompletions 从同一常量取子命令；recover 只列真实 orphan/pending IDs，源不可用返回 null。
resume 无参数，只解除当前 transport hold；无 owner 时可显示 status，resume 明确拒绝，不能隐式创 owner/control。
recover 展示确切旧目标，经 public newSession/setup 恢复，不悄悄投给当前 session。
空/部分/未知 prefix、ID prefix、资源不可用、owner 交接与真 reload 均有 A1 测试。

## 退休、恢复与验证

session_shutdown（quit/reload/new/resume/fork）只 fence 并等待已登记文件事务，不自动取消业务 intent。
仍 live 的第二 SDK manager 拒绝；同 manager reload 保留原三类 submitted；已退休后以新 manager
重开则等待旧 writer drain，建立新 slot/generation，重新读磁盘，不沿用已关闭 execution 的原生队列。
同进程仍保留旧 key 的 hold 集合；从下一进程恢复才把全部未完旧 key 标 held。
Task final 由 D 在撤权前 await B.cancelPending 及 D 自有 cancel；Side 显式 pre-dispose 接点由 B 拥有。
本库不能从同一个 public quit 事件猜出业务退休。Side view detach 不释放 execution endpoint。
缺 native queue 的正向失效证据时，导航拒绝跨 scope 漂移，并提示 fresh-process 对账。

`/mailbox recover` 的资源来自真实 snapshot 扫描；有历史文件使用公开 switchSession，缺文件的纯空 orphan
通过公开 newSession/setup + SessionManager.newSession({id}) 保持原 session ID，原子迁移 recovery location。
这种 orphan 的 reason=new 仍属于 restored snapshot，保持 recovery hold，直到 /mailbox resume 或 accepted input。
缺失文件但曾有非空历史证据时拒绝恢复，不能伪造 assistant/anchor。

`npm run check` 运行类型、事务故障/SIGKILL、callback、scope/branch/compaction 与 API 回归。
`npm run test:native` 分别 Bun bundle 两个 extension 后，在 stock Pi 1.5.0 新进程、隔离 HOME/agent/cwd/TMPDIR
和 offline faux 下检查 boundary 覆盖、async settled 两种顺序、USER/control 双顺序、facade 交接/reload、
以及 shared A/E fulfilled-final-ACK-lost 的零请求恢复。用 MAILBOX_PI_BINARY 显式指定测试 binary；脚本中的 ~/bin/pi-binary 仅是 legacy fallback，不是安装约定。
`npm run test:followup` 检查真实 SDK 的 seed/extension prompt、Main 卡片、closed→reopen、cold key 和无 A snapshot 的 legacy pending；
stock binary 检查 A→B→A、fork 后切回仍有 pending 的父会话、持续 proof conflict、自然请求消费后零多余 control。设置 MAILBOX_GOAL_BUNDLE
为已 build 的真实 Goal adapter 可另验 fresh RPC /goal 自动续行；脚本只复制其 artifact，依赖由 stock
host 提供，不运行其它工作树的 node_modules。check 另含 transport checkpoint 的真实 subprocess SIGKILL
矩阵（两条正文逐条前后、control、request、receipt、pending 删除与 source/A ACK 边界）。
所有 source-only consumer 的 compiled bundle 都须在整批集成时 rebuild，并新开进程；本库无 dist/build。

持久性验收范围是进程 SIGKILL / I/O 注入，不宣称断电级 Pi session fsync 保证。源 callbacks 必须幂等，
profile 内其它 context/provider adapter 必须在 full-profile faux gate 中保留 active mail 的最终投影；
任意第三方在本库最后一个可观测 public context hook 之后破坏请求，不属于自动送达保证。

## Read-only message projection for summary consumers

`mailbox-v1/light` and `mailbox-v1` export
`filterMailboxMessages(ctx, messages, { agentDir? }): Promise<AgentMessage[]>`.
The context needs only its public `sessionManager` and `cwd`. The result is a subset
of the input, preserving retained message objects and bytes; no messages are added.
It is the owner-supported filter for consumers that must summarize a public session
projection without running arbitrary extension hooks. Pi Session Compact uses it
before flattening rebuilt Main, small and native fallback inputs.

The API uses a conservative read-only predicate, guarded by owner/readonly contract
tests and byte comparisons for shared persistence rules: cancelled messages,
including receipt-backed tombstones after snapshot GC, and recovery-held/legacy/proof-error
carriers are hidden. A separate live or fulfilled reference to the same canonical
carrier retains the owner's existing shared-carrier semantics. With no live slot,
the reader reads only this session's snapshot/receipts and treats disk pending mail
as recovery-held. Session identity, ABI/build, stale binding and unreadable or
ambiguous storage fail closed. No customType-wide deletion or raw-body heuristics
are used.

Importing the light entry remains cold. Projection helpers load only on a call
that can contain a custom carrier; even an empty-slot call never imports the delivery
engine/writer or creates mailbox storage. The reader can await existing owner readiness,
but never binds/elects/activates an owner, reconciles proofs, invokes producer callbacks,
writes/ACKs/sends anything, or releases recovery hold. It also filters known live guard
errors/refusals, participant holds and missing registrations, without refreshing business
authority. This reader does not establish a new permission decision; the delivery owner
reruns guards on every actual request. Normal projection uses request-local admitted
references and preserves a carrier only when an admitted or fulfilled reference remains.
Readonly state is scoped to the public SessionManager, reuses unchanged snapshot/session
versions and is replaced when its session identity changes; it never creates a writer.
