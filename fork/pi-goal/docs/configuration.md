# 配置

[返回包入口](../README.md)。文件路径通过 Pi 公开 `getAgentDir()` 解析，为 `<agent-dir>/pi-goal.json`；不自行拼接 home，不读项目级 Goal 设置，也没有 Goal 专用环境变量覆盖层。只有内置默认值 → 有效用户文件 → 显式菜单/命令保存这条路径。

## 配置示例

```json
{
  "toolVisibility": "always",
  "experimental": { "goals": false },
  "rpc": { "enabled": false },
  "continuationLimits": { "automaticTurns": 25, "noProgressTurns": 3 },
  "backgroundWaitCheckInMs": 1200000
}
```

## 字段与默认值

| 字段 | 默认值 | 有效值与作用 |
| --- | --- | --- |
| `toolVisibility` | `"always"` | `"always"` / `"after-first-goal"`；terminal tools 基线可见性 |
| `experimental.goals` | `false` | boolean；实验性有序队列 |
| `rpc.enabled` | `false` | boolean；旧 managed RPC 协作开关，不是认证 |
| `continuationLimits.automaticTurns` | `25` | 正 safe integer，或 `null` 表示 Unlimited |
| `continuationLimits.noProgressTurns` | `3` | 正 safe integer，或 `null` 关闭 tool-free 重复检测 |
| `backgroundWaitCheckInMs` | `1200000` | 至少 `60000` 的 safe integer 毫秒，或 `null` 关闭后台等待巡检 |

顶层必须是 JSON object。已知嵌套字段的容器也必须是 object；缺字段使用默认值。任一已知字段无效或 JSON malformed 都警告并回退**整套**默认值，不部分加载，更不覆盖坏文件。缺文件不创建目录、锁或文件。后台巡检兼容旧 `processWaitCheckInMs`：新字段缺失时读旧字段；两者同时存在且不相等视为 invalid。保存时写 canonical `backgroundWaitCheckInMs` 并删除旧 key。

## 工具可见性不等于拥有全局 tool list

- `always` 不主动隐藏 `goal_complete`/`goal_blocked`，保持稳定 schema。
- `after-first-goal` 在 fresh runtime 隐藏两者，首次接受激活后解锁直到该 extension runtime 结束；恢复 unfinished Goal 也解锁。
- restore 使用较早 lifecycle handlers 留下的 tool set，不把 restrictive policy 隐藏的 terminal tools 强行补回。active Goal 缺任一 terminal tool 时先暂停，禁止自动发下一轮。
- 失败的 kickoff、replace、resume、reactivating edit 恢复激活前**确切** tool set，包括其他 extension 原本显露的 tools。
- 需要扩大 busy turn 的 schema 时拒绝，等 settled 再试。Goal 不在每轮对抗全局 tools policy。
- live settings 从 after-first-goal 改为 always，只还原 Goal 自己隐藏过的 tools；反向修改时，没有 unfinished Goal 的 runtime 重新上锁。
- tools 消失导致的暂停只 abort Goal-owned kickoff/resume/active-edit/continuation，不取消或 stale-block 无关用户/extension turn，包括 restrictive restore 后的 startup follow-up。

## 读取、保存和失败

session_start（含 replacement 与 `/reload`）重新读文件；不 watch 外部编辑。菜单显式修改在保存成功后立即生效。外部编辑后 reload，改源码后仍须 rebuild + fresh process。

TUI `/goal` → Settings 在同一层展示 Automatic-work limit、No-progress guard、Goal tools、Ordered goal queue、Managed run RPC。前两项进入标准 choice screen：正整数可自定义，Unlimited/Off 必须用明确选项，不用 0 或负数代替。Unlimited 要确认会持续消耗 token/provider cost。`backgroundWaitCheckInMs` 用 `/goal idle-checkin` 或编辑 JSON 设置，不冒充菜单第六项。

交互保存按用户操作顺序排队，先从最新有效 document 读取，保留未知顶层和嵌套字段，在目标目录写临时文件再 rename。失败恢复此前显示值和 runtime 设置、通知路径；失败不毒化后续操作。Escape 只返回，不回滚已成功保存的修改。会改 active schema 的 visibility 修改在 busy 时拒绝。

这些是单进程内排序，不宣称跨 Pi process 写入互斥。无效原文件阻止保存，TUI Settings 显示只读摘要和修复路径；修好后 reload。Goal settings 不存 credentials，状态与错误不应包含凭据。

旧 managed RPC 开关关闭时拒绝新 start，但已接受 run 仍能发精确状态及接受精确 cancel，直到 terminal，避免 stranded work。reload/replacement/shutdown 清掉 in-memory managed ownership，不能接管手动或恢复的 Goal。协议见 [协议合同](protocols.md#managed-rpc-旧兼容)。

## Host-owned 规则附录

`<getAgentDir()>/goal-append.md` 是宿主管理的可选规则，不是 Goal settings、项目配置或用户 objective。它靠近 active Goal rules 追加，用于协调宿主的 scope/verification policy；暂停分支不能带入这个持续推进附录。文件缺失或空白不追加内容；读取与诊断遵守 [维护说明](maintenance.md#规则附录与读取成本) 的边界。
