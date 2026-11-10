# 生命周期与安全合同

[返回包入口](../README.md)。Goal 使用 Pi 公共 lifecycle/context/session API，不要求 host patch 或 private field。提示是行为约束，不是隔离模型工具访问的沙箱。

## 状态与续跑

`active` 才能正常推进；`paused` 表示用户/安全中断，`blocked` 表示真正外部阻塞或终止性非 quota 错误，`usage_limited` 表示 provider/account quota 耗尽，`budget_limited` 表示用户 token budget 耗尽，`complete` 表示接受了完成工具。队列中的未激活项另有 `queued`。

一轮没完成时先记录 continuation intent；只在 `agent_settled`、idle 且没有 pending messages 后派发一次。retry、自动 compaction、steering、follow-up 先排空，不用定时器猜 Pi 队列已丢失。自动投递通过 [Mailbox](mailbox.md) 处理 durable acceptance、native carrier 去重与恢复；手动 start/resume/edit 保留 user input 语义。不能把 `sendUserMessage` 返回当成 host 已接受的证明。

后来的用户/extension 工作可 supersede 旧 continuation；重复 settled 不得重复 dispatch。手动 compaction 没有 `agent_settled` 的窄路径复用 single-flight idle dispatcher，不开 polling loop。Pi extension 无法原子预留 idle turn，其他 extension 仍可能在检查后抢先开始；mailbox 的证据和 policy 决定投递，不宣称没有 race。

## 默认 25+3

`automaticTurns` 默认 25，统计 Goal-owned run 的每个正常 completed `turn_end`，包括用户触发 kickoff/resume/edit、tool loop 内的 model responses、automatic continuation 和匹配的 Pi-owned retry。它不是“25 个工具”或“25 次纯自动 follow-up”。普通 non-Goal user run 不计入。

达到上限后，Goal 以 `continuation_limit` 暂停，取消 pending continuation/recovery，在第 26 个正常 response 开始前 abort。provider adapter 可能收到一次已经 aborted 的调用，以生成 synthetic terminal event；该事件不计数，不恢复 Goal。有限 cap 暂停保留累计 token、活动时间和队列，用户 review 后 resume 开新 epoch。显式 `null` 是 Unlimited，不关掉 token budget 或其他 guard。

`noProgressTurns` 默认 3，仅在 automatic run 结束时比较可见 assistant text：Unicode normalize、转小写、去控制符和折叠空白；thinking/tool blocks 不参与。空白与纯标点等价；连续空白或 normalized-identical、无工具输出增加 repeat count。不同非空内容从 1 起算，任何 attempted tool call 清零。它是启发式，不证明业务没进展；distinct 短回复也不会被当成重复。`null` 只关闭此 guard。

active Goal 收到直接 non-`/goal` user/RPC input 时开启新 safety epoch，并将 in-flight work 重新归类为 manual；该新 epoch 仍统计其 Goal-owned responses。extension input 或 stopped 时的消息不重置。shelving、priority displacement、自动换队和再激活保留各 item 的 epoch，不借队列操作赠送新额度。计数、fingerprint、pause cause 跨 reload/compaction 持久化。

## 完成与 blocked 审计

所有 active kickoff/resume/edit/system/continuation/budget-wrap-up 提示使用同一逐项完成审计：objective 是经过转义、带 trust boundary 的用户任务数据；保持完整 scope，依据当前文件、命令输出、测试、runtime、PR/artifact/external state 核实。计划、旧对话、弱或间接证据不能当成完成证明。

`goal_complete({ goal_id, summary })` 要求当前确切 id 和非空完成证据。缺失/过期 id 先拒绝；明显自相矛盾的摘要（如还没完成或 tests fail）拒绝。普通 assistant text 永远不完成 Goal，即便目标要求 exact reply。工具不能自行验证所有外部工作，prompt 也不是验证结果。

resume/active edit/replace 会换 id；旧 stopped/replaced/cleared turn 的延迟工具不能完成新目标。paused、blocked、usage_limited 不能直接完成；budget_limited 只允许其有界 in-flight wrap-up 内凭既有证据完成。目标工具还检查当前 run ownership，不只检查字符串 id。

`goal_blocked({ goal_id, reason, evidence, repeated_turns })` 只用于同一 blocker 连续至少三个 Goal turns 仍存在，且证据证明需要用户或外部行动的真 impasse。reason 非空且最多 1,000 字符；evidence 非空且最多 4,000 字符；repeated_turns 必须是至少 3 的整数。stale id、stopped Goal、空/超长文本、非整数都拒绝。接受后变 blocked，停止自动续跑，并在 Pi 能安全做到时终止 tool batch。困难、未完成、普通澄清、可恢复失败都不够；resume 后重新做三轮 blocker 审计。

## Token budget 与活动时钟

每条持久化 assistant message 优先使用 finite、非负 `usage.totalTokens`；缺失/无效时回退到 finite、非负 `input + output + cacheRead + cacheWrite`。不另加 reasoning（已属 output）或 cacheWrite1h（cacheWrite 的子集）。usage 是当前 branch assistant 累计量减起始 baseline，rewind 后最低归零。

provider usage 只有 message 完成才权威，所以 budget 最多可能多出一次 model call，并非硬性美元限额。工具活动结束首次发现耗尽时，Goal 一次性进入 budget_limited，取消续跑，在下一请求前放入最多一个非用户写入的 wrap-up instruction。只允许简短进度/结果/blockers 摘要；substantive tool attempt 会被挡并 abort 剩余 wrap-up，拒绝的 goal_complete 也终止 wrap-up。预算耗尽本身不能证明完成；若直到 agent_end 才知道耗尽且没有剩余 turn，不额外开 model turn。

25-response cap 不是 cost ceiling：上下文、cache、输出长度和 provider pricing 都影响费用。Pi 用 provider usage 和本地 pricing 估算，Goal 不查询账单余额。更紧控制可降低 automaticTurns 或设置 `--tokens`。

elapsed 只累计真实 active clock。pause、blocked、usage/budget limit、shutdown/offline 都停钟；frozen queue 即使 phase 仍 active 也停钟。旧 entry 保留累计秒数，恢复时只在允许运行的状态重开 clock。snapshot 消费者必须以 [clockRunning](protocols.md#goal-snapshot-v1) 为准，不能从 phase 推断。

## 中断、retry 与 stale tool guard

用户 abort/pause 产生 paused；terminal quota 错误产生 usage_limited；其他 non-retryable agent error 产生 blocked。停止取消相关 continuation/delivery，必要时 abort stale work，并阻止旧轮后续 tool calls，直到新 non-Goal user input、成功重激活/replace 或 clear。clear 清理 stale block，但不 abort 无关 in-flight turn。

可重试 provider 错误和 overflow compaction retry 期间保持 active，继续记其 Goal-owned responses，不多排 continuation。只有 matching recovery 在 agent_settled 后仍未解决、且无 retry/compaction/follow-up，才转 blocked；stale recovery 不得影响 replacement Goal。terminal tools 在 tool loop 或换队前消失就暂停，不发新 model turn，不对抗 restrictive policy。

暂停后的后台结果 turn 使用 request-scoped context，每次 provider request 都看得到停止规则；不注入 active rules、`<goal_id>` 或 host append，不调用 beginAgentRun，不记 Goal usage，不再续跑，两个 terminal tools 拒绝。读取/检查/记录结果仍可需要写工具，所以不加通用 tool allowlist；模型不继续推进依靠明确提示，不能宣称机器只准读。后台 Task/process 继续受自己的 deadline/取消控制，见 [命令合同](commands.md#暂停不是取消后台任务)。

## Session、tree 与 legacy records

canonical `goal-state` custom session entry 保存 `{goal}`，按需附加 `queue`、`pendingAction`、`pendingContinuation`、`mailbox`。内部包含 token baseline、active clock、safety epoch、pending queue action 和 exact owed marker；这不是跨插件读取接口，消费者用 [公开协议](protocols.md)。

`/reload` 或重开同 session 恢复 unfinished Goal；同 cwd 的全新 session 不继承。restore 已达 finite cap 时，在下一 provider request 前暂停。after-first-goal restore 解锁但不扩大被较早 handler 限制的 tool set。shutdown 先 checkpoint 再停钟，offline 不计时。

`session_before_tree` checkpoint 即将离开的 branch 的 stopped clone，但 live clock 到导航成功才停，取消导航不漏记。`session_tree` 只读目的 branch，恢复目标/队列/safety/pending queue/owed/source intents；清掉 ephemeral menus、retry、check-in/accounting 与旧 async authority。导航自身不追加 Goal entry、不发送 prompt、不启动 provider。分支前于创建或后于 clear 就没有 Goal。mailbox lineage 防止 sibling retarget；后台任务生命周期不随 tree 变化。

旧 `{goal}` 仍有效，缺失 safety fields 补零/defaults。只有当前 branch 从未写 canonical goal-state，才从旧 `goals-state` 数组和 pending unshift 迁入；任何 canonical entry（包括 clear）都优先，不能复活旧 plural state。多项或 pending transition 在实验关闭时冻结、保留全部项，允许 inspect/clear，不自动推进；单项 legacy array 可当普通 Goal。旧 `<agent-dir>/pi-goal-state.json` cwd 全局文件不再恢复；clear 只清当前 cwd 的旧 entry。

后台 completion 已被 Goal receipt 接收而欠一轮时，先持久化 owed marker，再归还 receipt；恢复后只欠该确切一轮。paused 保留到 resume，clear/complete 去掉；同 completion 不应引出两轮。source session/branch authority、native acceptance 和失败 hold 详见 [Mailbox](mailbox.md)。
