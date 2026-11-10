# 命令合同

[返回包入口](../README.md)。设置、安全与持久化分别由 [Settings](settings.md)、[生命周期](lifecycle.md) 和 [Mailbox](mailbox.md) 定义。

## 语法

| 命令 | 行为 |
| --- | --- |
| `/goal` | TUI 打开状态管理菜单；RPC 发状态 notification |
| `/goal status` | TUI 显示状态卡；RPC 发状态 notification |
| `/goal [--tokens <budget>] <objective>` | 开始目标；替换未完成目标前确认，重置累计使用量 |
| `/goal edit` | 打开编辑器，预填当前目标；取消或不修改不改变状态 |
| `/goal edit [--tokens <budget>] <objective>` | 保留累计使用量，更新当前目标 |
| `/goal modify` | 编辑器预填当前目标，通过同一 edit 路径提交；不接受参数 |
| `/goal pause` | 暂停 active 目标，停止 Goal 自动投递并 abort 当前轮；保留进度 |
| `/goal resume` | 恢复 stopped 目标；budget 必须仍允许继续 |
| `/goal clear` | 清除当前目标或整条队列、Goal status、续跑与旧 cwd 记录 |
| `/goal idle-checkin <duration\|default\|off>` | 保存后台等待巡检间隔；不要求已有 Goal |

objective trim 后必须非空，最多 4,000 字符。parser 支持单/双引号分组；`--tokens` 必须紧挨在 objective 之前。budget 为正数，可带大小写不敏感的 `k`/`m`，如 `100k`、`1.5m`；换算向下取整后必须为正 safe integer。未列出的首词通常是 objective，不是任意 subcommand；已保留的无参命令拒绝尾随输入。

`idle-checkin` 默认 20 分钟，`default` 恢复该值，`off` 关闭。duration 至少 1 分钟，支持小数及 `ms`、`s`、`m`、`h`，不带单位按分钟；也接受 minute/minutes/min/mins、hr/hour/hours。结果必须是 safe integer 毫秒。它只巡检当前 active Goal 正在等待的有效后台 lease，既不是 process timeout，也不是 Task deadline，更不会因巡检自动延长它们。关闭它不关闭 producer 自己的结果通知。queueFrozen 或 pending queue action 的变更 guard 同样适用，不能用此设置命令绕过。

兼容输入仍接受 `stop` → `clear`、`idle-check-in` → `idle-checkin`，巡检关闭值 `disable`/`disabled` → `off`。补全只展示 canonical 名称和有限 scaffold，不展示隐藏 alias。

## 菜单与模式

TUI 裸 `/goal` 按当前状态给出开始、暂停、恢复或提高 token budget 的操作；Settings、Status、Help 与清除入口保持浅层。菜单的 Replace、Clear、Prioritize、Skip、Drop last 会预览确切受影响目标并确认；既有 direct queue/clear routes 为自动化保留即时行为，不额外确认。

达到 response limit 后，菜单展示 **Review and continue…**：保留 objective、累计 usage、活动时间和队列；Continue 将安全 epoch 归零，最多再走一个已配置 epoch。可以改 limit 而保持暂停；Back/Escape 不继续目标。状态展示 `used/limit` 和剩余数量，Unlimited 明示为 Unlimited。

`/goal status` 是阅读操作，不写入 conversation。TUI 状态卡支持方向键、PgUp/PgDn、Home/End 滚动，Escape/Enter 关闭；无 Goal 时只通知。读取状态仍 checkpoint accounting。普通菜单用方向键和 Enter，Escape 返回，Ctrl+C 关闭整个流程；`modify` 取消或原文不变不改状态。

RPC 裸 `/goal` 和 `status` 通过 observable notification 返回，不打开 TUI。print/JSON 没有 extension-command 的状态输出通道，这两条路线明确拒绝，而不是把 stderr 当输出。`modify` 需要 editor，print/JSON 拒绝并提示改用 `edit <objective>`。需要确认或交互的路径不能被当成 headless 自动化接口；纯文本 direct routes 保留正常验证和状态变更，其 UI notification 不是 print/JSON 的结果协议。managed RPC 另见 [旧兼容接口](protocols.md#managed-rpc-旧兼容)。

## 启动、编辑与恢复的事务边界

- start/replace 的 kickoff 发送失败：新目标清掉，或恢复旧目标；旧 active 目标恢复为 paused。
- active edit 会换 `goal_id`、开始新 safety epoch，并发送更新后的任务。paused/blocked/usage_limited 的 edit 保持停止及安全计数；budget_limited 只有 `edit --tokens` 把预算提高到当前 usage 以上才重新激活。
- edit 发送失败恢复旧 safety counters、fingerprint 和 pause cause；旧 active 目标恢复为 paused，旧 budget_limited 保持原状态。
- resume 适用于 paused、blocked、usage_limited、budget_limited。成功会换 `goal_id`，当 resume prompt 实际开始时重置 automatic/repeat epoch，保留累计 token/时间/队列。发送失败恢复原状态、id、计数、fingerprint 和 cause。
- tool schema 不能在 busy turn 中因激活而扩大；需要显露 tools 时等 idle 再试。两个 terminal tools 不可用就拒绝激活。
- 所有需撤销旧 mailbox authority 的变更都先过 durable cancellation barrier；失败保留可见 hold，不宣称 pause/clear/replace 成功，详见 [Mailbox](mailbox.md#取消失败不能伪装成功)。

## 暂停不是取消后台任务

pause 停止 Goal 推进，不会取消已启动 process/Subagent Task。后台结果自己的 wake 仍可进入对话。暂停上下文允许模型读取、验证、记录结果，但不允许接着推进 objective、调用 `goal_complete`/`goal_blocked`；该轮不取得 Goal accounting ownership，也不产生 Goal 自动续跑。只有 resume 才恢复推进。

Process deadline 和 Subagent Task deadline 由各自 owner 维护，相互独立，也独立于 Goal 的活动时钟、token budget、25-response epoch 和 idle-checkin。Goal pause、clear、tree navigation 都不负责杀任务；要取消，调用生产方自己的操作。clear 也不会 abort 不相关的 in-flight turn。

## 实验性有序队列

只有 `experimental.goals: true` 才启用以下语法；启用后 session 会显示一次实验提示。

| 命令 | 行为 |
| --- | --- |
| `/goal add [--tokens <budget>] <objective>` | 追加尾部；无 Goal 时立即开始 |
| `/goal prioritize [--tokens <budget>] <objective>` | 插入队首；busy 时先持久化 intent，等待旧 run/retry/pending messages settled |
| `/goal drop-last` | 删除队尾；只剩 head 时相当于 clear |
| `/goal skip` | 删除 head；只在 settled idle 边界激活下一项，stopped 下一项仍 stopped |

隐藏 alias：`push`、`unshift`、`pop`、`shift` 分别对应 add、prioritize、drop-last、skip。补全不展示 alias。`/goal <objective>` 仍替换整条队列，edit/pause/resume 操作 head。

关闭实验时，queue 首词回到原 parser 的普通 objective 文本，例如 `/goal add docs` 创建 `add docs` 单目标。不过，已有多目标或 pending queue transition 会冻结，不能通过普通 objective 绕过；只允许 `/goal` 菜单/`status` 检视或 `/goal clear` 移除。重新启用后等旧 Goal-owned run settled 再恢复，外部改文件需 reload。兼容旧 plural state 只含一项时可作为普通单目标加载，不强制实验开关。未冻结但已有 pending queue action 时，除 show/clear 外的 direct 操作也要等该 action settled 后重试。
