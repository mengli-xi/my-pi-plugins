# 工具呈现 contract

适用于 Pi 1.5.0；[runtime contract](./spec.md) 定义执行、配置和 lifecycle 边界，[README](../README.md) 列出命令与完整功能。呈现不得改变 model 可见的参数、result、结构化 details、错误或 session 历史，也不得为了恢复显示重新执行工具。

## 策略

| Tool/活动 | 默认呈现 | 完整详情 |
| --- | --- | --- |
| `ask_user_question` | standalone，保留结构化答案 | transcript/详情 panel |
| `web_search`、`web_fetch` | standalone，原样 query/URL、状态、耗时 | overlay 中的原始 result |
| 内置单文件 `edit` | standalone，原生 diff | inline 与 overlay |
| 多文件/未知 patch | grouped；只有安全 adapter 能证明单文件时才独立 | overlay |
| `bash/read/grep/find/ls` | grouped，只有一次调用也不例外 | Activity transcript |
| MCP、process、subagent、todo、未知工具 | adapter 与已配置的 grouping/native 策略 | Activity/native 详情 |

重要活动在工具组前后形成边界，相邻 standalone 不合并；它们不改变上层 Activity phase 的边界。`toolCallId` 去重，parallel 与 nested 调用不重复计数；nested 归实际 model-issued parent，只有 outer call 暂停 working 指标。历史 duration 用记录的 `durationMs`，不以 assistant 生成时长冒充执行时间。未持久化的 nested result 明确说未保留。

`importantTools.askUserQuestion/webSearch/webFetch/singleFileEdit` 默认 true，`webDetails` 为 `overlay`；独立校验各字段，禁用后回既有 grouping。Todo native checklist 是明确例外。新工具无专用 adapter 时仍 grouped，不以来源 package 决定是否保留完整 native transcript。

## Grouped 与实时活动

已完成低信息量摘要缩进、无成功 bullet，例如 `  Ran 1 shell command`；混合类别合并为一句。运行组可用中性 shimmer，失败/取消必须有明确 glyph/text，不能只靠颜色。折叠摘要最多两行，不显示键位提示；truncation/ellipsis 共用 dim tone。

spinner 下方的活动工具是独立 component，不嵌进 working 文本。每个调用最多两行，bash 优先保留 elapsed 后缀并限一行；第 3 列的 `└` 与 Todo 对齐。点击按稳定 `toolCallId` 打开完整 args、已上报 partial output 和终态；暂无输出明确显示等待，不伪造结果。多调用汇总没有唯一对象，不把点击误路由到新补位行。关闭/挂载失败必须退订，session 清理把未完成详情标记 cancelled。

## 问卷

结构化 `details` 有效时不解析 model envelope。保留问题顺序，用短 header 作为 label：

```text
⏺ User answered Agent's questions:
  ⎿ Choice -> Selected label
```

single-select/custom answer 显示标量；multi-select 保留全部 label；note 不丢。未答取消明确 declined，部分作答后取消保留答案并追加取消状态。`details.chat` 与 `details.explain` 分别显示 `Chat about this:` / `Explain More:`，不能把非取消空结果误认为已回答。title/header 用正文强度、chrome muted、答案深蓝；错误保持明确错误状态。仅隐藏视觉 envelope，session/result 数据原样保留。

## Web 与 Edit

Web header 保留原样 query/URL，ANSI-safe 换行；一次 invocation 计一次 search，progress 原位更新，不追加新行。成功显示 `Did 1 search in Ns` / `Fetched in Ns`；紧凑时长四舍五入为秒，完成且非零最少 1s。失败/取消和简洁错误 inline 可见；raw snippets、page body、provider/method/metadata 留在详情，不混入主摘要。live 和历史使用相同记录字段，不重新请求网络。

Edit 复用原始 call/result renderer 和 diff painter，原样转发 `state/lastComponent/invalidate`。新增/删除各有背景与更强的变更 span 背景；context 透明。完整 diff 的续行按操作标记、补齐行号和正文空格组成的完整 gutter 悬挂缩进，并扣除该宽度；极窄/运行 preview 保留既有降级。不解析任意 shell 输出来猜编辑文件，也不复制 Pi diff 算法。

## Delegate UI

Delegate 展示归 `ToolPresentationAdapter`，不是执行层。`spawn_agent` 的成功 versioned result 提供冻结的 model/effort，显示 `Delegate to provider/model@effort`；不从当前 Main 或请求 args 猜这两项。任务名、描述和调用状态沿用现有来源，分别来自 args 与 activity，不承诺从 result 恢复名称或计数。`args.model` 可以省略；只有请求、尚无成功身份时保留既有 Spawning 表述。缺失/畸形身份保留既有 Spawning/Spawned 文案，未知 effort 只显示实际 model，不拼造 effort；失败、拒绝和取消不显示成功 Delegate。

回归覆盖成功 frozen result 与冲突 args、`args.model` 省略、pending、malformed/rejected/cancelled result，以及 group/overlay/cache 和长身份截断。保留原任务描述和状态断言。交互检查使用实际 `spawn_agent`、`send_input`、`wait_agents` 等协作工具及 `/subagents [<target>]` 命令。

## Activity、Thinking 与详情

`GroupStore` 保存 grouped/standalone 的有序工具时间线。`ActivityTimelineStore` 引用同一 tool activity，按 assistant content 顺序混排 Thinking segment 和具体 tool call，不复制 provider/session message。

- Activity phase 唯一业务边界是实际可见、非空的 assistant 正文；tool call/result、user、message end、agent lifecycle 均不切 phase。
- 当前 active Thinking 默认显示完整正文，footer 可切换本地 disclosure；手动折叠跨 delta 保持，正文不消费点击。结束后该 block 保持当前展开态，直到下一个不同 thinking block 接管；历史恢复不误判成新 block。当前 footer 只切 inline，不打开 panel。
- 有 grouped anchor 的 completed Thinking 归档到 Activity transcript；每段可测量耗时归其后的 tool batch，末尾归最后一批，不重复计时。无 anchor 保留 standalone 确保可达。历史 compact Thinking 点击打开该 segment 的详情；不编造缺失 timing。
- grouped 点击、`Alt+O` 和 `/tool-transcript` 打开所属 phase，不只打开点击的 group。每次打开全部折叠；Thinking 展开用 `thinkingText` 的 Pi Markdown，tool 展开保留完整捕获 args/result/error/diff/metadata 与高亮。
- 外框用 UIKit `SelectableCollapsiblePanel`：顶底 rule 同 accent，title 和 adaptive 键位位于右端，窄宽仍保留 label；item 用 `CollapsibleBlock` 两列语法，不加嵌套竖框或空白行。相邻 item 的 `borderMuted` inset divider 不可选、不可点击，末项后不画。
- tool 折叠最多四行：动作摘要、最多两行关键输出、固定状态/结构化退出码（若有）/耗时尾行；running 不显示成功。展开 section 使用统一 `Arguments/Result/Diff/Details` label；高亮主内容不得隐藏 cwd/timeout 等其余参数。
- `↑/↓` 移 item，accent `→` 标记；Enter/Space 和 marker row click 切当前项。`j/k`、PgUp/PgDn、Home/End、wheel 只滚详情。仅 marker row 可折叠，拖选不误触。
- live 订阅 Activity/ThinkingDocument/GroupStore，按稳定 id 保留 selection/fold/viewport；reorder 跟随同 id 并使 marker 可见。普通 delta 不重置用户滚动。关闭、失败和 teardown 释放全部订阅。
- `/tree` 按当前 branch 重建相同顺序、答案、web 状态和 diff；历史 assistant component 与 hydrate timeline 复用 ThinkingDocument identity，重复重建不得重复行/空 phase/segment。可取消的 before-switch/fork 不作不可逆清理。
- tool payload 与完整 Thinking 分别复用 `maxGroups/maxCapturedBytes` 的 count/UTF-8 上限。active phase 不裁剪；旧 completed phase 释放正文但保留轻量顺序和 `details released`，不改历史行几何。

## 图片、输出与鼠标

`terminal.showImages=false` 时，任意 grouped tool 的带图 result 加 `⎿ View Image (size)` 或 `View N Images (total size)`。纯图片 read 不保留空摘要；同组入口集中按工具顺序排列，每个 result 一行，无额外空行。入口取 Pi 交给 renderer 的 result，点击不重读文件、不另存图片；GroupStore 只保留展示行弱引用与数量/大小。只有 read 的图片带 path。

preview 用专用 non-overlay editor replacement panel，避免普通 compositor 改写 image protocol 的预留高度；关闭恢复 draft/focus。`showImages=true` 时 Pi 照常 inline 画图，CC 不加入口，doctor 提示；native presentation 保留 Pi 自己的图片文字行为，不增私有 image seam。

native output cap 只影响可见行，保留原 renderer 与完整结果，点击可读；`respectExpanded` 决定 Ctrl+O 是否解除上限，`compactShell` 决定是否使用 self shell。内容本就放得下时逐字节不变。

内容行只响应 Pi 公开 normalized `handleMouse` 的已完成左键 click；selection、drag、wheel、focus/capture 和坐标归 fullscreen host。CC 不写 DECSET，不给 handleClick-only 组件造兼容桥。regular 仅保证安全降级，详情可用 `Alt+O` / `/tool-transcript`。UIKit 负责 panel 自身滚动、拖选复制与关闭。
