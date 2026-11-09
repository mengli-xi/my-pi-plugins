# pi-claude-style

目标运行时为 stock Pi 1.5.0。Main 不要求 Pi 源码 patch；native child 的主题能力检查另由 `pi-session-runtime` 负责，不能据此跳过其 capability gate。

现行设计与边界见 [runtime contract](./docs/spec.md)、[工具呈现 contract](./docs/important-tool-presentation-spec.md) 和 [statusline contract 与来源](./docs/statusline-provenance.md)；[维护策略](./LOCAL_PATCHES.md) 说明必须保留的设计取舍。

为 Pi 提供 Claude Code 风格的 transcript 展示：

- 唯一拥有 editor chrome：在输入编辑器预留的左侧 padding 中添加固定强调色 `❯ ` prompt 前缀，在上边框左侧显示原生输入历史位置 `History x/y`、右侧显示 session name，并在下边框右侧显示 Git 状态；所有装饰都不改变提交文本；
- 将连续的工具活动折叠为语义摘要行；
- 在 spinner 下方可点击的活动工具区块中显示正在运行的调用，而 transcript 只保留折叠后的分组摘要；
- 将已回答的问卷、Web Search/Fetch 和单文件 Edit 保持为 Claude 风格的独立区块；
- 按 `Alt+O` 在编辑器位置以全宽 TextPanel overlay 打开完整捕获的参数/结果；
- 配置后支持原生 `Ctrl+O` 行内展开；
- render Claude 风格的工作指标以及持久的最终 `done` 行；
- 移植 cyber-ui 的呼吸指示器、字母波浪 shimmer 和 500 ms 实时 TPS 平滑；
- 在紧凑的框中 render 已提交的用户消息：超过 `userMessages.maxLines`（默认 3）行、且至少能藏起 3 行时才折叠成前几行加 `… +N lines`，否则完整显示；
- 在保留 Pi 原生 thinking render 的同时，为每个 assistant 文本块添加 Claude 风格的 `●` 前缀，增加文本/thinking 间距；`Ctrl+T` 交给 Pi 1.4 原生实现，原地切换，不重建聊天；
- 将突发的 assistant 文本快照平滑为受帧预算约束的打字机流，而不是为每个 provider delta 重建 Markdown；
- 持久保存不进入上下文的 turn 分隔线和 Codex 风格的运行完成分隔线；
- 在 Pi 的 TUI 展示边界装饰由 Pi 直接加载的工具，因此折叠无需把源 plugin 的 lifecycle 交给此 package；
- 第三方 Pi extension 的执行和 lifecycle 仍归 Pi 所有；
- 通过 `presentation/claude-style-v1` capability 向 `pi-subagents` 和 `pi-side-chat` 提供专用 `dist/child.ts`：读取同一用户配置，安装 transcript、working row、editor chrome 与只读 statusline，不注册任何 execution tool（descriptor `tools: []`）；不安装 Main `/cc-style` control plane、Goal/Todo ownership、notification presenter、model selector或外部 statusline contributor。child 不修改 Pi 全局 package-update presenter；原生 child host 只初始化 view，不启动 package updater。


## 重试 Working 行

Fullscreen 的 Main、Side 和子 agent 共用 Working 行：Pi 原始 `auto_retry_start` 的
`attempt/maxAttempts/delayMs/errorMessage` 追加为 warning 色的「网络异常 / 限流 / 上游不可用 / 异常 ·
重试 N/M · Ns 后（Esc 取消）」。倒计时每秒变化，包括 2000ms 慢刷新配置；现有单 timer 会额外唤醒到下一个整秒，spinner、动词和 shimmer 沿用原节奏；新请求或
`auto_retry_end` 清除重试信息。次数和退避策略仍由 Pi settings 决定，最后失败仍由重复错误折叠逻辑吸收。

`compat/working-retry.ts` 仅包装 `InteractiveMode.handleEvent` 和 `showStatusIndicator` 两处私有边界，
保留原处理器的 Esc 绑定和最终通知；原生 retry indicator 在被替换时立即 dispose。任一 probe 失配就完整保留
Pi 原生重试显示，`/internals` 可查状态。regular 模式保留 Pi 原生重试。session 级快照通过公开 subscribe 记录，在 view detach 后保留，首次进入和重新进入均按原开始时间恢复；
请求开始、取消、重试结束和 session shutdown 清除。原型包装 bindExtensions / init 也按私有接缝审计，
这两个恢复探针失配只禁用恢复，保留上一版当前视图行为。当前总计 25 个私有面（16 eager、9 live；历史探针另有实时实例校验）。

child 生命周期：`npm run check-retry-child:host -- /path/to/pi` 覆盖 Side/Subagent 在等待中重进、后台等待后首次进入、Main 隔离及取消后再次进入。

真实 host 用例：`npm run test:host-fixtures -- /path/to/pi --only retry-main,retry-side-chat,retry-subagent,retry-escape,retry-fallback-events,retry-fallback-indicator`。

## Provider activity 与指标

Working 只消费共享 `pi-runtime-contracts/provider-activity-v1` 的 `provider:activity-v1` 观测：
任意非空 provider ID 与当前 session ID 必须同时匹配；未知版本、非法字段和其他身份的事件一律忽略。
`local` / `upstream` 队列分别保留位置，重叠排队只扣一次 elapsed；`queuedMs` 优先，缺失时使用
`queueEnteredAt` 或本地接收时间。turn end 关闭排队并清 retry，run 结束和 session 清理释放状态。
load、retry 和 queue 仍由本包绘制，provider owner 只提供语义数据；专用事件的翻译归外部 adapter，
本包不读取旧 channel、品牌 API 或配置，不改变执行、排队、重试策略，也不新增 timer 或改变 frame cadence。

所有 provider 的 TPS 都要求至少 500ms 连续生成观测，避免缓冲 delta 形成虚高读数。可观测的正 output usage
作为精确累计值，Anthropic 的公开流式 usage 语义也保留；没有计数时继续估算。计数来源切换时重新建立速率基线，
不把估算与精确值的差当吞吐。terminal done/error 的 usage 只结算精确总数，不充当一个流式速率样本；
完成行仍用完整 generation time 与最终 output 计算全程平均，过短窗口不显示 TPS。

## 命令

- `Alt+O`：打开最新的工具分组。
- `Alt+T`：折叠或展开 spinner 下方的 todo 列表。
- `/model` / `Ctrl+L`：model 按 provider 分组到 tab 中；`Tab` 和 `Shift+Tab` 在 tab 之间移动，搜索和选择仍使用原生行为。 单 provider tab 的模型行省略重复的 `[provider]`；`scoped` 筛选结果包含多个 provider 时保留标签，区分同名模型。 所有 provider 的模型行尾都读取模型自身上下文窗口和图片输入能力，显示如 `IMAGE 600k`，不支持图片时用 `IMAGE` 的等宽空白占位；窗口按完整筛选列表的最大文本宽度左补空白，元数据段固定贴最右、负载/额度在左，因此容量长度不移动图片/窗口列；不依赖 capacity snapshot，空间不足先保留上下文/图片标记，仍放不下则保留原模型行。模型 id 后以 muted 显示自定义展示名（非空、不等于 id、且不以 id 结尾）；空间不足先省略展示名，再按原有顺序保留行尾元数据，原生搜索已匹配展示名。每个 tab 显示其 provider 的 model 总数，导航提示位于底部分隔线中，selector 为最大 provider 预留内容高度以避免切换 tab 时跳动。加载 `pi-model-capacity` 后，model 负载/quota、请求并发量、订阅窗口以及账户 remaining 会原地刷新；当前 provider 摘要与 Pi 原生 `Model catalogs refreshed.` 合并为一行，不再另占一行。quota 按剩余量使用暗绿、暗黄、暗红，load 保持 muted，DeepSeek remaining 在 >0 时为暗绿、耗尽为暗红。selector 只负责展示，并在关闭时停止轮询。
- `/tool-transcript`：选择并打开历史分组。
- `/tool-transcript show`：显示生效的 runtime 状态。
- `/tool-transcript config`：显示配置路径。
- `/cc-style config list transcript.assistantMessages.typewriter`：检查统一 `conf` store 中的打字机设置。
- `/cc-style cache`：打开 active branch 的 prompt-cache 趋势面板；点击 statusline 的 `CH/RU/M` 也打开同一面板。
- `/cc-style perf on` 和 `/cc-style perf`：启用并检查 CC Style span、event-loop 和进程内存指标。fullscreen 几何和附加效果归 CC 的 `layout.*` 配置与 `fullscreen.*` probes。
- `/perf export` / `/perf open`：写入或打开集中式、自包含的 HTML 报告，其中包括 CC Style discovery 的 batch/settle/cancellation 数据。

## 配置

Plugin 设置由 `<agent-dir>/extensions/pi-claude-style/config.json` 中的 `conf` store 管理。`<agent-dir>` 由 Pi 公开 `getAgentDir()` 解析，并遵守 `PI_CODING_AGENT_DIR`；不要假定固定 HOME 路径。应优先使用 `/cc-style config
get|set|reset <path>`，而不是手动编辑 JSON。重新加载 extension 后 renderer 设置才会生效；验证编译后的改动时请重启 Pi，因为运行中的进程会保留已加载的 extension module。

package 根目录的 `config.json` 是仍被 `src/config.ts` 消费的 legacy fallback：旧 `CONFIG_PATH` 不存在时会读取它。它不是现行 schema v6 的默认值清单，其中旧 `integrations` 不代表恢复 hosted loader；不要仅因字段已退役而删除该运行资源。

已有 schema v6 store 在启动时直接读取并经过完整的 document/字段校验，首次写配置时才同步加载 Conf 和它的依赖。
缺失 store 的首次创建、旧 schema 迁移和显式损坏恢复仍在原时机经 Conf 原子写入；损坏内容仍保留原字节并进入只读诊断状态。
Conf writer 单独打包为 `dist/config-storage.cjs`，通过同步 require 首次加载，兼容 stock Pi 的 compiled Bun host；主入口不静态导入该文件。

冷启动 UI 加载也在同一个 store 中配置。`loading.mode=balanced`（默认）让命令面板和 overlay 在首次使用时加载；`eager` 会在首个 context 和 `loading.idleDelayMs` 之后预热；`minimal` 禁止空闲预热。`loading.preloadOverlays` 和 `loading.preloadDiagnostics` 可将单独类别加入 balanced 预热。`/cc-style status|doctor` 显示 module 状态；`/cc-style perf` 报告 import 成本和用户可见的等待成本。

`maxGroups` 分别限制保留完整 payload 的工具分组数量和 completed Activity phase 数量，而不是现有行数；`maxCapturedBytes` 也分别限制工具参数/结果与 Thinking 正文的 UTF-8 bytes。payload 裁剪不能改变历史行几何；fullscreen history window 另按批次卸载、保留高度锚点，并在需要时重建组件。较旧的工具分组只释放参数/结果；较旧的 completed Activity phase 只释放完整 Thinking 正文并保留时间线骨架与明确的 `details released` 提示。active phase 永不裁剪。

`working.style` 可选择 `"cyber"`（动画彩色显示）或 `"plain"`。`working.spinnerIntervalMs` 控制 Claude 配色 spinner 的节奏，`working.refreshMs` 控制指标/shimmer 的刷新率，`working.messageWidth` 则是 spinner 两个固定行各自的宽度上限；实时终端宽度可以进一步降低该上限。第一行始终包含 headline。第二行始终包含状态：如有 provider activity 则先显示它，随后是必需的已用时间，再后是空间不足时按重要性丢弃的可选指标。headline 独立截断，两行绝不合并，即使所有内容能放进一行也是如此。安装后的默认值为 `"cyber"`、`180`、`120` 和 `100`。

每项指标显示为 `glyph value`，速率显示为一个词，任何分隔符两侧都不会出现超过一个空格。标签、glyph、标点和分隔符使用柔和灰色。值保持正常字重，并使用独立的暗色分类 palette：已用时间、输入、输出、首 token、thinking 和 turn 计数各有一种克制的色调，而不继承 spinner 的赤陶色。TPS 低于 20t/s 时为暗红色，从 20t/s 到低于 50t/s 时为暗赭色，达到 50t/s 时为暗绿色。turn 计数位于该行末尾：

```text
Reasoning...
  0.3s · ↑ – ↓ – · 󰄉 1
Tissant...
  2.4s · ↑ 10.0k ↓ 42 · 9.2t/s · first 1.8s · 󰄉 1
Explaining a longer reasoning-summary headline...
  1m01s · ↑ 128k ↓ 12.4k
```

不会为历史显示宽度预留空间：长 headline 后接短 headline 时，不会留下不可见的前缀列。Token 计数器仍从第一帧起占用其单元格（在 provider 报告 usage 前显示 `–`），累计计数器绝不倒退，而仅在运行后期才存在的指标——速率、首 token 时间、thinking 时间——会在可用时出现。

transcript 会保留稳定的折叠分组摘要和已完成历史记录，但正在收集的分组不再为当前命令添加子行。该实时详情属于 spinner 下方的可点击 component。每个并行调用最多占两行，复用与 overlay 相同的展示 formatter，并在截断前先换行。活动工具文本在 spinner 下方保持静态中性灰色；只有正在收集的 transcript 摘要使用柔和的中性扫光。Pi 将 spinner glyph 放在屏幕第 1 列；每个工具/Todo 的 `└` 都从向后两列的第 3 列开始：

```text
Checking the renderer...
  12.4s · ↑ 128k ↓ 4.2k · 55t/s
  └ $ npm test a/long/path/that-wraps
    -- --runInBand · 3.2s
  └ Read src/working.ts · 1.1s
  └ ■ 修复 spinner tool block
```

点击活动工具行，只打开该行 `toolCallId` 的实时详情：完整参数、已上报的 partial output，以及结束后的结果或错误；没有输出时明确显示“执行中，暂无输出”。面板复用 live text 订阅，关闭时释放订阅，session 清理时将仍运行的详情标记为 cancelled；不会改动工具执行或 session 记录。续行归属同一调用，列表变化后不把旧行误映射到补位的新调用。持久工具区块保持当前高度。多项折叠汇总没有唯一调用，不能点击打开全部；单项折叠仍可打开该项。其显式折叠形式对并行调用使用数量，单个调用使用简短语义前缀，而不是显示 `1 tool`：

```text
  └ 3 tools running
  └ Shell · 3.2s
```

Todo 仍是独立的可点击 component。仍有工作时，点击它和按下 `Alt+T` 操作的是同一个独立折叠状态。所有 Todo 项完成后，该 component 会从编辑器上方移除，statusline 显示 `✓ todo N/N`；点击该 segment 会在编辑器上方恢复完整的已完成 checklist，再次点击 checklist 或 segment 则会重新折叠。折叠后的 transcript 摘要通常使用相同的灰色 palette，最多换为两行，并省略行内键盘提示；`Alt+O` 仍会打开最新的可检查分组。Pi 设置 `terminal.showImages=false`时，Pi 不再在 transcript 里画工具结果的图片，CC 为每个带图片的 grouped tool result 画一行 `⎿ View Image (123 KB)`；同一次 result 含多图时显示 `View N Images (total size)`。`read` 和 MCP 截图等所有工具都一样。图片 read 单独成组时，空摘要不会占行；其他情况摘要照常显示，入口跟在后面。同组图片行由第一个带图片的工具结果集中排列，每次结果仍占一行，行间没有空行；后续结果到达时按工具顺序更新，恢复会话也使用相同布局。GroupStore 只保留展示行的弱引用，不复制或序列化图片；Pi 持有的各结果容器始终持有自己的图片行。该布局只用公开 renderer 和 Container API，不增加 Pi private seam。点击该子行会在专用 editor replacement panel 中显示该次 tool result 交给模型的图片（直接取 Pi 交给 renderer 的 result，不重读磁盘，CC 也不另存图片数据），点击摘要正文仍打开 Activity transcript；只有 `read` 的图片带 path，其他工具的图片在面板里不提供复制路径和打开。`terminal.showImages` 为 true 时 Pi 照常 inline 画图，CC 不加入口，`/cc-style doctor` 会提示把它关掉。同类 process 分组会优先显示 process 标识：`Process 'api' starting`、`Process 'api' started`、`Process 'api' stopped` 和 `Process 'api' output read`。两个已知名称会保持可见；更大的分组使用数量。Start 使用暗蓝色语义扫光（启动失败仍为暗红色）。成功 stop 保持柔和色调；只有失败的 stop 工具调用会变为暗红色。持久 terminal 行的标识保持柔和色调，只以相同的暗淡强度为状态短语着色：成功为绿色，exit/signal/runtime 失败为红色，仅真正的结构化 process timeout 为黄色。混合 process 操作回退为 `Managing N process operations`。截断和进行中省略号在整个 UI 中使用同一种 dim 色调。

spinner glyph 和完整 headline（包括末尾的 `...`）使用固定的 Claude 赤陶色 shimmer。状态标签和分隔符使用当前 theme 的 `muted`/`dim` 色调；值使用独立的暗色分类 palette。Provider load、retry、queue position 和 queue duration 使用自己的暗色调，而不是 spinner 颜色或明亮的语义高亮。完成 glyph 保留语义状态颜色。

`assistantMessages.style` 可选择 `"claude"` 或 `"native"`。`assistantMessages.marker` 和 `assistantMessages.markerColor` 用于自定义逻辑区块 marker。子项按 component shape 而非位置匹配，因此即使其他 extension 添加了子项或 Pi 改变其内容布局，marker 也只会落在正文文本块上。

`assistantMessages.typewriter` 将 provider 交付与 Markdown 重建解耦。传入的快照会被合并，只有 component 接收缩短后的 projection；protocol message 和 session history 保持完整。默认节奏为 50 ms，每帧前进 3–160 个 UTF-16 code unit，在生成期间以 160 ms 的视觉延迟为目标，并在 1.2 秒内排空最终尾部。自适应模式会将近期 Markdown update、TUI render 和 event-loop 延迟与 8 ms 预算比较。存在压力时，它会延长下一帧，默认最多延长到 200 ms，同时增大追赶 batch；它不会仅因 provider/network 间隙作出反应。尾随的工具调用或 terminal error 会绕过队列，确保工具执行和失败反馈绝不延迟。控制项如下：

```text
transcript.assistantMessages.typewriter.enabled
transcript.assistantMessages.typewriter.frameMs
transcript.assistantMessages.typewriter.minCharsPerFrame
transcript.assistantMessages.typewriter.maxCharsPerFrame
transcript.assistantMessages.typewriter.targetLagMs
transcript.assistantMessages.typewriter.finalDrainMs
transcript.assistantMessages.typewriter.adaptive
transcript.assistantMessages.typewriter.renderBudgetMs
transcript.assistantMessages.typewriter.maxFrameMs
```

打字机、工作行、goal 刷新、preload 延迟和保留行到期任务共享一个 runtime scheduler。在 4 ms 窗口内到期的任务共用一次原生 wakeup，同时保留每项功能的 wall-clock 节奏。scheduler 会随 runtime 一起 dispose，且不会安装另一个 TUI render wrapper。

`/cc-style perf` 是按 producer 过滤的进程级 `pi-perf` telemetry 视图。它会报告 delta 间隔、有效帧延迟、adaptive 压力和 throttle 决策、batch 大小、backlog 分布、当前/峰值 backlog、Markdown update 成本、scheduler wakeup/coalescing/lateness、RSS/heap，以及 event-loop utilization/delay。当 `pi-perf` 拥有共享 UI probe 时，它还会把字符输入拆分为 handler、render-request 和 completed-paint 阶段，并把消息提交拆分到 Enter 处理、公共 input event、agent 启动、render request、spinner 和 completed paint。慢样本会在这些阶段间保留同一个 correlation ID，但不记录输入的文本。同一个 probe 会将 overlay Enter 与编辑器提交分开。它能区分保持打开和关闭的 overlay 交互，并把已完成的 Ask User Question 与工具恢复及 overlay 后的首次 paint 关联起来。Terminal 行/列变化既按帧测量，也按一次稳定后的 resize burst 测量，因此拖动 pane 边缘时，报告的是从首次变化到最终完成帧的完整耗时，而不仅是最后一次中间重绘。
报告还包括 presentation-adapter resolve、activity 和 group-summary 延迟；adapter/fallback/error 数量；以及 identity-cache hit/miss。`/perf` 会将同一 producer 与其他已连接 plugin 一起显示，`/perf top` 则按 p95 对所有 plugin span 排名。执行 `/cc-style perf on` 前指标保持关闭；`/cc-style perf log on` 会要求集中式 provider 将此 producer 的慢 span 追加到 `<agent-dir>/perf-ui.jsonl`。
`/perf export` 生成自包含的可视化 dashboard，`/perf open` 在默认浏览器中打开同一报告；两者都会将 CC Style span 与全局 input、paint、event-loop、resize、memory 和其他 producer 指标结合起来。

Prompt cache 面板与 statusline 共用 active-branch analyzer。`CH` 是本轮 `cacheRead / (input + cacheRead + cacheWrite)`；`RU` 是相对上一轮可复用 prompt 的命中率；`M` 是未复用 token。provider 从未报告 cache activity 时，`RU/M` 保持不可观测，不把 0 错报成完整 miss。面板显示固定 0–100% 刻度的 CH/RU 双趋势、token 加权汇总和逐 provider request 明细。analyzer 最多保留最近 120 个请求；趋势按面板宽度截取，宽屏/窄屏明细分别显示最近 20/12 个请求，汇总仍覆盖完整 active branch。`compaction`/`branch_summary` 会断开 RU baseline，model switch 保留 baseline 并显式标记，超过 5 分钟的间隔会显示 idle note。数据直接从 session branch 重建，因此 `/reload`、resume 和 tree navigation 不需要另一份缓存文件。

Thinking 区块保持 native Markdown，可用 `Ctrl+T` 查看或折叠历史内容。`assistantMessages.collapsedThinking` 默认为 `"activity"`：当前进行中的 thinking 无视历史折叠开关，默认显示完整正文，并在正文末尾显示 `▴ Thinking 42s`；点击 footer 可切成单行 `▸ Thinking 42s`，再次点击恢复。手动折叠会跨后续 streaming delta 保持，正文行不消费点击，便于选择文字。正文、tool call 或 assistant settle 结束当前 thinking 后，当前展开状态继续保留，直到另一个不同的 thinking block 开始。新 block 默认展开并接管 disclosure；前一个 block 才折叠为单行耗时，若所在 phase 已有 grouped Tool transcript 入口，则归档到 Activity transcript。这个交接只属于 TUI presentation，不改变 Activity 或模型生命周期；历史恢复不会把 completed block 误当成刚结束的当前 block。CC Style 同时建立跨 assistant message 的 Activity phase，唯一业务边界是**实际可见、非空的 assistant 正文**；tool call/result、user message、agent start/end 和 assistant message 结束不切 phase。每段可测量耗时附在它后面的 grouped transcript 行上，例如 `Ran 2 tools · Thinking 42s`；phase 末尾的 Thinking 归到最后一行，同一段不会重复计时。phase 没有 grouped 入口时，completed standalone Thinking 继续保留，避免内容不可达。

当前 Thinking 的 footer 点击只切换 inline 正文，不再打开 Markdown panel；footer 始终跟在最新正文后面，适合长 thinking 自动滚动到末尾后的操作。交接后的历史 compact Thinking 行仍可点击查看该 segment。footer 耗时在流式 thinking 期间即使没有新的 reasoning delta 也会每秒更新，结束后冻结。点击 grouped Tool transcript 则打开该 phase 的 `Activity transcript`：Thinking segment 与具体 tool call 按真实 content 顺序混排、默认全部折叠；Thinking 展开后使用较浅 `thinkingText` 色调的 Pi Markdown renderer，tool 展开后继续显示完整参数、结果、diff 与语法高亮。`/tree` 切换 branch 会原地重建两份 projection；可取消的 session switch/fork 不会提前销毁当前 transcript。完整 Thinking 历史与 tool payload 共用现有 `maxGroups` / `maxCapturedBytes` 上限；旧 completed phase 超预算后保留时间线顺序和明确的详情释放提示。Reasoning-summary headline 仅保留在工作 spinner 中。

`"preview"` 仍是显式 opt-in，会将已完成的 thinking 过程折叠为其自身内容的预览：

```text
  Thinking: 用户想让我先看一下配置文件，然后决定改哪里。config.json 里
            已经有 overlay 段落了，直接扩展它比新开一个字段…
```

折叠后的运行最多占两行，第二行悬挂对齐在第一行文本下方，因为从一个完整句子定位一段运行，比从半句话定位容易得多。行数绝不取决于内容——短运行只占一行——因此折叠不会改变 transcript 尺寸。断行优先选择词边界，附近没有合适边界时回退到列；CJK 始终采用后者。

不会显示 `(Ctrl+T to expand)` 后缀：它占用的宽度大于带来的价值，`Ctrl+T` 仍然有效，点击活动计时器或预览即可完整打开该次运行。`"label"` 仍可用于 Pi 的旧式静态隐藏 thinking 行。

`assistantMessages.hideCodeFenceMarkers` 隐藏 render 后的代码围栏起止行，保留代码正文。范围只有 assistant 正文、CC 的 thinking 行和 Thinking/Activity 面板，都用包装组件实现；用户消息、compaction/branch summary、skill invocation 和其他扩展的 Markdown 保持 Pi 原样。

从 clipboard 粘贴图片时，Pi Editor 中显示的 `[Image #n]` 是原子占位符：左右移动会跨过整个 marker，Backspace 与 Delete 一次删除整个 marker，Undo 会连同 path 映射一起恢复。提交给模型和 session 的仍是原始图片路径。programmatic `setText()` 收到仍存在的 `pi-clipboard-*` path 时也会重建同样的 marker，供 Rewind 恢复历史输入；缺失文件保持原 path，让 caller 安全降级。CC Style 还通过 `pi.claude-style.editor-image-source.v2` 提供只读 source projection 和明确的恢复回执，供 Rewind 保存当前 draft 的可恢复 source，不暴露内部 Map。这个行为复用 Pi 0.85 的 `Editor.segment()` 编辑边界；custom editor 没有该 seam 时保留原路径，不生成不可安全编辑的占位符。

Activity transcript 每次打开时默认将全部 Thinking segment 与 tool call 折叠。外层直接使用 UIKit `SelectableCollapsiblePanel`：顶线与底线使用同一个 accent tone，title 和自适应键位说明分别嵌在两条 rule 的右端；正文中的每个 item 复用 UIKit `CollapsibleBlock` 的两列语法，不再绘制 `▌` 内嵌边框或 item 间的额外空行，相邻 item 之间改用一条 UIKit `borderMuted` inset divider。divider 不属于 item heading，不可选也不可点击。Thinking marker 显示 `Thinking · <elapsed>`（历史没有可靠 timing 时不伪造），展开后显示 Markdown；tool marker 的折叠 block 最多四行：首行使用 presentation registry 提供的语义动作摘要，中间最多保留两行关键输出，末行固定显示状态、结构化退出码（若有）和耗时。例如：

```text
▸ Ran ps -p 46406 -o pid,etime,stat,command
  zsh:1: operation not permitted: ps
  ✗ (127) 0ms
```

展开后显示完整调用参数和完整结果。bash command、JSON 参数、按文件扩展名识别的代码以及 diff 分别复用 Pi syntax highlighter 和现有 diff painter；高亮不会丢掉 `cwd`、`timeout` 等附加参数。`Arguments` / `Result` / `Diff` / `Details` 使用 UIKit 相同的两列 section label，内容再缩进两列。

`↑`/`↓` 在这些 block 间移动选中项；当前项使用 accent `→` marker。选择会按稳定 activity id 保留，live delta 或 item reorder 不会将 selection 跳回首项。`j`/`k`、PgUp/PgDn 和滚轮只负责滚动详情，不改变选中项；移动 selection 时 viewport 会自动让对应 marker row 可见。

点击 marker row会选中并展开该调用的参数和结果，再次点击则折叠；`Enter` 或 `Space` 会对当前选中项执行同样操作。`▾` 表示展开，`▸` 表示折叠。整条 marker row 都是点击目标，并且只有这条 row 可点击——点击其他任何位置都不会执行操作，因此不会意外折叠长结果。折叠属于 view state：overlay 关闭时会重置，每次打开时所有内容均为折叠状态。

折叠某个调用时，其 marker row 上方的内容不会移动，因此 scroll position 得以保留。只处理按下事件；后续松开报告会携带相同坐标，否则会将刚刚折叠的内容再次展开。

`overlay.mouseScrollLines` 控制 mouse 滚轮每一档滚动多少行 transcript。`SelectableCollapsiblePanel` 使用 overlay `ui.custom()`：编辑器和 transcript 保持挂载，panel 保持编辑器原有宽度和底边，并覆盖其上方的消息行。

点击从绝对 terminal 坐标映射而来。UIKit 的 editor-overlay wrapper 根据同一编辑器和 trailing-root 几何信息计算合成原点，再通过结构化 `setScreenOrigin(row, column)` contract 提供该原点，用于滚轮滚动、拖动复制和点击折叠。

Pi fullscreen 拥有鼠标解码、滚轮与选区。CC 只把命中 overlay 之外的左键按下交给声明 `wantsMouse` 的焦点面板，使其关闭且不穿透；UIKit 不写 DECSET 鼠标模式。

## 点击 transcript 行

点击 transcript 中的行会打开该行所摘要的内容：

| 行 | 打开的内容 |
|---|---|
| `Read 3 files · Thinking 42s`、`Ran 1 shell command` 及其他所有 grouped Tool transcript 行 | 该行所属 Activity phase 的完整 timeline——Thinking segment 与具体 tool call 按真实顺序混排，而非只显示所点击的工具组；归属于该 tool batch 的 Thinking 累计耗时附在对应行上 |
| `View Image (123 KB)` / `View N Images` | 当次 tool result 中的图片（`terminal.showImages=false` 时才有这一行）；不重新读取磁盘路径 |
| Web Search / Web Fetch / 已回答的问卷 | 同一个 `SelectableCollapsiblePanel`，其中包含完整查询和结果 |
| 单文件 Edit | 同一个 `SelectableCollapsiblePanel`，其中包含完整参数和 diff |
| 当前 active Thinking footer | 切换该 segment 的 inline disclosure；历史 compact Thinking 行才打开文本详情 |
| 已折叠的 `process` 结果（参见*外部工具输出*） | 命令的完整输出 |

在 transcript 文本上拖动会选择并复制文本。双击会选择并复制指针下的 Unicode 词；CJK 分词和宽单元格坐标都会保留。单击仍会打开可点击的摘要行。

常规模式输入在编辑器的**可见文本正文**上支持相同的 mouse 手势。拖动可以跨越换行后的行；松开会复制显示的文本，双击则复制一个 Unicode 词。不能从编辑器边框、autocomplete 行、pinned widget 或 footer 开始选择。这是仅供视觉复制的选择：它既不会移动 Pi 的光标，也不会创建可编辑范围；下一次普通输入会清除高亮。复制结果 badge 固定覆盖在 editor 顶边框正上方一行的右侧，不随 footer/statusline 高度漂移。全屏模式则保留 Pi 自身的全屏选择。

当前 active Thinking 的 footer 只切换本地 inline disclosure；历史 compact Thinking 行打开对应 segment 的文本详情。Pi 的 `Ctrl+T` 仍控制全局历史 thinking 展开态，不能替代 CC 每个 block 的本地 disclosure。

历史 Thinking 详情和普通文本使用 TextPanel 的编辑器位置 overlay grammar：先是一行全宽空白分隔行，其下是强调色标题分隔线；Thinking 在分隔线右侧显示当前 segment 的动态耗时，普通文本则保留行数或 viewport 位置说明；正文前再留一个空行；底部是柔和色调的右端 adaptive 提示。Activity transcript 使用 `SelectableCollapsiblePanel`：title 与键位说明分别嵌在同为 accent 的顶/底 rule 右端，并用 `→` 显示当前选中项。两种 panel 都不绘制竖直边框：

```text
── ✻ Thinking ─────────────────────────────────────────── 12s

  用户想让我先看一下配置文件，然后决定改哪里。config.json 里已
  经有 overlay 段落了，直接扩展它比新开一个字段干净。
──────────────────────────── y copy · Enter/Esc close
```

每个 rich TextPanel 都占用编辑器完整宽度。正文至少保留 3 行，整体高度最多为 terminal 行数的 70%，并继续受 editor slot 可用高度与调用方 `maxVisible` 限制；短内容只按正文与 frame 所需高度展开，长内容则在固定 viewport 内滚动。compositor 为 panel 提供编辑器 slot 的完整宽度和底边，因此 panel 会在消息流上方向上扩展，而真实编辑器、编辑器下方 widget 和 footer 均保持原位。

该次运行通过 Pi 自身的 Markdown renderer 绘制，因此列表、强调和围栏代码会按其含义显示，而不是显示源文本；`hideCodeFenceMarkers` 在此同样生效。无法 render 为 Markdown 的正文会回退为普通换行段落，而不是无法打开。

它*不会*使用 Pi 的文档 Markdown theme。Reasoning 是一个声音在大声思考，而非文档：书写时不会太在意 markup，一个段落下方偶然出现的 `---` 就足以让任何 Markdown parser 将该段落视为 setext heading——Pi 会将其绘制为明亮、粗体且带下划线（level 1 为 `heading(bold(underline(text)))`），于是 model 无意强调的句子会像在高喊。这里会改为让每个元素都使用 thinking 颜色，并完全去掉下划线；结构仍可从缩进和项目符号中读出，而这里本来也只承载这些信息。

与 `/ctx-status` 不同，它可以滚动，因为 thinking 过程没有长度上限。Thinking 专用 panel 将标题行右侧固定用于 run 耗时；滚动仍由正文 viewport 维护，底部提示保留复制、滚动和关闭键位。普通 TextPanel 仍可在标题行右侧显示 `1-22/62` 之类的 viewport 位置。

## 在 TextPanel 中移动

两个 rich view 使用相同按键；screen origin 可用时，两者都可用滚轮滚动：

| | |
|---|---|
| `↑` `↓` `j` `k` | 一行 |
| `PgUp` `PgDn` `Ctrl+F` `Ctrl+B` | 一屏 |
| `Ctrl+D` `Ctrl+U` | 半屏 |
| `Home` `End` `g` `G` | 顶部、底部 |
| `y` `c` | 将完整正文复制到剪贴板 |
| `Enter` `Esc` `Ctrl+C` | 关闭纯文本 panel |

使用 `g` 而非 vi 的 `gg`：这里没有其他内容以 `g` 开头，因此等待第二个按键只会增加出错方式。

**点击启用 mouse 的 TextPanel 外部会将其关闭。** editor-overlay wrapper 提供精确的合成原点，因此 component 绘制边界是确定的。Escape 始终会将其关闭。

**内容超出屏幕后会出现 scrollbar。** 因为没有竖直边框充当轨道，所以右边缘只显示 grip；它不占宽度，所有内容都能放下时不会出现。thumb 至少占一行，并且只有真正到达最底部时才会触及最后一行，因此“接近末尾”绝不会看起来像“已到末尾”。

**拖动进行选择，松开进行复制。** 拖动时选区会以反色显示；拖过顶部或底部边缘后，正文会继续在选区下方滚动；进入剪贴板的是显示出来的选中文本——escape code 会被去除，右边缘会被裁剪。由于选区以正文坐标而非屏幕坐标保存，滚动会让文本在选区下方移动，而不会丢失选区。面板选区由 UIKit 维护，transcript 选区由 Pi 维护。

选择需要 motion report，因此启用 mouse 的 TextOverlay 在打开期间会同时请求 `?1002` 和 `?1000`/`?1006`。

`y`（或 `c`）则会复制**全部内容**，并且取的是*源内容*而非屏幕内容——一次运行的 Markdown、一次调用的参数和结果——所以可以粘贴到编辑器而非 terminal 中。footer 右下角会说明结果（`Copied 123 chars to clipboard`），直到下一次按键恢复提示。

点击在松开而非按下时解析，因此从可折叠 marker row 开始拖动时可以选择文本，而不会将其折叠。

card 会将位置读数（`8-18/30`）保留在标题行而非 footer 中，因为 footer 是窄 card 最不能溢出的一行——让末尾的 `Press Escape to close` 消失比丢失其他任何内容都更糟。

**标题和 footer bar 由分隔线隔开**；分隔线比 frame 更亮，并在两侧各提前两列结束。碰到边框的线看起来像另一条边；内缩的线看起来才像分隔。panel 会在 footer 上方使用同一种分隔线，而不再绘制此前的全宽 `├───┤`。
`Enter` 也会关闭它，与该 dialog 保持一致。工具 transcript 保留自己的全高 panel：它用于阅读较长的捕获输出，如果 card 会随调用折叠和展开而改变尺寸，体验反而更差。

Pi 1.4 fullscreen 自己维护 viewport、滚动、选区和鼠标捕获，将 normalized `handleMouse` 事件派给 CC 内容行，包括 Skills 委托来的 `Loaded skill` 行。regular 已退役，CC 行不响应 regular 点击，可用 `Alt+O` 或 `/tool-transcript` 打开详情；详情面板属于 UIKit。

点击会在松开时派发，并且只会在期间未选择任何内容时派发，因此从可点击行开始拖动选区仍会执行选择。

一行所调用的 opener 会通过每个携带 context 的 event 激活，而不仅是 `session_start`。`/reload` 会创建新的 module instance，但绝不会重放 `session_start`，因此若只在那里激活，session 剩余期间所有行都会失去响应——看起来就像点击功能根本没有实现。

同一个 reload 间隙还决定哪个 module *构建*一行。工具行来自工具定义，每次激活时都会重新装饰，因此始终属于当前 instance。Thinking 行来自对 `AssistantMessageComponent.prototype` 的 patch；该 patch 会跨 reload 保留，因为 disposer 只在 `session_shutdown` 时运行，而 `/reload` 从不发出该 event。因此安装 patch 时会采用此前 instance 保存的原始项，而不是发现已有 patch 就退出。否则，thinking 行会一直由 Pi 启动时加载的 module 构建，无论怎样编辑此 package 都不会生效，直到重启 Pi。

没有 hover 反馈：报告 mouse 移动意味着每移动一个单元格就产生一份报告，不值得为高亮承担此成本。可点击行看起来与其他行完全相同，因此能打开内容的行正是那些本就像更大内容摘要的行。

`separators.showTurnSeparators` 默认禁用，因此内部 model/tool turn 不会割裂单个用户请求。禁用后还会隐藏此前持久保存的 turn 分隔线。
`separators.showRunSeparator` 会在 `agent_settled` 后添加持久行，例如 `─ ✓ done · Worked for 28.0s · ↑8.3k ↓450 ─`。这条运行完成行将一次用户对话与下一次分隔开。它是 Pi custom entry，因此可跨 reload 保留，但绝不会进入 LLM context。`separators.replaceDoneWidget` 避免重复显示相同的完成统计信息。

## 外部工具输出

由 Pi 直接加载的 package 工具都会经过同一个仅影响 TUI 的展示 decorator。归类为可分组的工具会折叠到一起，而其执行、命令和 lifecycle 仍归注册它们的 package 所有。明确配置为 native 展示的工具会保留自己的 renderer；配置过的大型 native 结果仍可限制行数，其余内容点击即可查看：

新工具默认使用通用折叠分组。当 transcript 应显示比通用工具摘要更具体的内容时，应添加语义 classifier。Native 行内 render 是显式的策略例外，应附有记录在案的理由；工具由 Pi 直接加载本身绝不是理由。

工具专属文本应放在 `ToolPresentationAdapter` 中，而不是 TUI 边界或源 plugin 中。adapter 可以独立匹配工具、选择展示策略、格式化实时活动行、汇总同类分组，并可选择分配语义分组色调。adapter 按优先级排序，返回 `undefined` 表示委托，并在失败时开放回退到现有语义 formatter。默认 registry 包括 process、subagent 和 MCP adapter；混合分组继续使用通用的多类型摘要。GroupStore snapshot、activity 和 args 以对象 identity 缓存在 `WeakMap` 中，因此 steady-state 帧不会再次运行 adapter 匹配，缓存的 payload 也不会成为第二个常驻索引。

```text
⏺ Process(output backend-dev)
  ⎿ Recent output for "backend-dev" (156 lines)
    … +37 lines · click to view
```

空白行会先于内容被丢弃，因此用空白行分隔各节的工具不会把全部预算浪费在空内容上。已经能够放下的结果会原样传递——与工具绘制的内容逐字节一致——只有实际隐藏了内容的行才需要点击。

默认情况下，`Ctrl+O` 不会解除上限。工具展开时，分组行也不会增长；只有在没有内容展开时才保持简短的 transcript 并不算真正简短。如果更愿意原地阅读输出，`respectExpanded: true` 会把 `Ctrl+O` 交还给工具。

这些工具也会从 Pi 的默认工具 shell 中移出。默认 shell 是一个 `Spacer(1)` 后接一个 `Box(1, 1)`——每次调用前有一个空白行，其内容上下各有一个带 padding 和 tint 的行，因此连续两次调用之间隔着三个空白行：

```text
              ← Spacer
              ← box padding
Process: start "wait-g03b-time-function-7fa9"
Status: Started (proc_53, PID: 25745)
              ← box padding
              ← Spacer
              ← box padding
Process: start "wait-g03b-time-architecture-e58b"
```

它们改用 `self` shell——即自行绘制 frame 的工具所用的 shell，也是此 extension 的分组行已经使用的 shell：调用前一个空白行，无 padding，无背景 tint。这样，外部工具就能与 transcript 其余部分保持相同节奏，而不是漂浮在自己的框里。`compactShell: false` 可恢复 Pi 的 frame。

点击后会打开与 thinking 相同的 card——card 会要求工具按 card 宽度绘制*同一个结果的展开版本*，因此显示的是工具使用自身颜色完成的自身 render，而不是对它的转录。无法绘制的工具会回退到逐字结果文本，而非 Markdown：日志中的围栏、井号和星号都是输出，不是格式。

无论上限是否隐藏了内容，点击都会生效。工具早在应用上限之前就会折叠自己的结果——`process output` 显示一行状态，并自行保留一屏命令输出——因此能放下的行仍然是某些内容的摘要，popup 是查看其余内容的唯一方式。

```json
{
  "nativeToolOutput": {
    "enabled": true,
    "maxLines": 2,
    "tools": ["process"],
    "respectExpanded": false,
    "compactShell": true
  }
}
```

`maxLines` 会计入提示行，因此默认值 `2` 会保留一行工具自身的输出。`tools` 与工具名称进行不区分大小写的匹配；添加一个本就 render 两行的工具没有任何收益，反而可能隐藏真正重要的一行，因此默认只列出 `process`。

fullscreen 下这一行通过 Pi 公开的 `handleMouse` 接收点击，打开完整输出；regular 模式不保证点击，上限照样生效，查看其余内容用 `Ctrl+O`。

## 通知与扩展消息

`ctx.ui.notify()`、Pi 自己的状态行、版本和 package 更新提醒都用 Pi 原生样式，CC Style 不再改写。

扩展发出的显示型 custom message，凡是 producer 自己注册了 renderer 的，归 producer 画。下面这些 producer 没有注册 renderer，CC Style 用公开的 `registerMessageRenderer` 画成紧凑样式：类型名占一行，正文缩进在下面，没有底色框；带 `details` 的点一下打开详情面板（`details.markdown` 按 Markdown，其余按 JSON）。

| customType | producer |
|---|---|
| `internals`、`cc-style.command-output`、`cc-style.command-error` | pi-claude-style（`/internals`、漂移报告、无 TUI 时的 `/cc-style`） |
| `fork-update` | pi-fork-update 的批量报告 |
| `goal-budget-wrap-up` | pi-goal 的预算收尾提示 |
| `mcp-ui-prompt`、`mcp-ui-intent`、`mcp-ui-context` | pi-mcp-adapter 的 MCP app UI 回传 |
| `mcp-oauth-status` | pi-mcp-adapter 后台 OAuth 完成/失败，details 带 server/status/nextAction |

其他类型保持 Pi 原生的带底色框，内容完整。列表在 `src/command-output.ts` 的 `COMPACT_MESSAGE_TYPES`；producer 以后自己注册 renderer 时，要从这里删掉，Pi 对同一类型只用第一个扩展的 renderer。`customMessages.style` 设为 `native` 时全部交给 Pi。

同一个 live run 内，连续出现、归一化后文字完全相同的 assistant 错误会折成一个可点击行，不限 provider 或错误格式。归一化只忽略开头的 `Error:`、`Retry failed after N attempts:`、空白差异和已知会变的 `attempts`、`request_id`、`log_id` 字段值（request/log ID 可带由字母数字和下划线构成的 namespace 前缀，如 `vendor_log_id`）；字段名必须完整，且位于开头或空白、`(`、`,`、`;` 之后，值不跨越空白、括号、逗号或分号；不明确的结构保留原文。其余文字（包括诊断字段）必须完全相同。摘要取末尾 ` (…)` 诊断前的部分，没有诊断则用整条错误，沿用现有宽度规则。重试中显示 `… ×N`，最终失败显示 `… N/N`；点击可查看每次原始错误、request ID、时间及最终 retry notice。不同错误、可见 assistant 正文、工具调用、其他错误通知、扩展通过 `ctx.ui.notify` 发出的 info/warning 通知或 run settle 都会切断聚合；后两类扩展通知通过公开 `ExtensionRunner.setUIContext` / `ExtensionUIContext.notify` 包装处理，不覆盖 Pi 内部直接调用的 status 通知。最终那条 `Retry failed after N attempts` 通知由公开的 `InteractiveMode.showError` 包装收进这一行，其余通知都走 Pi 原生。这里只改 component projection，不修改 retry、provider 请求、session entry 或历史恢复；重启后历史仍按 Pi 的原始记录呈现。

## Goal 状态

`@narumitw/pi-goal` 通过 `setStatus` 报告，而被替换的 footer 或命令驱动的 statusline 可能吞掉该报告。此 extension 使用 pi-goal 的语义 snapshot 并自行绘制状态——默认右对齐放在 statusline 专用的第三行：

```text
example-project │ main +3 -1 │ example-model high ⚡  #42 │ 2h15m
[61.1k/200k] 31% MC61% │ ↑26.7M·↓492k │ R:48k·W:2.1k       CH:78.6%·RU:91.2%·M:4.3k
todo 14/16 │ pkg 24g/0p                                     Goal paused 7h45m10s 608.8M
```

它只显示状态和 goal 的成本，不显示其他内容。objective 很长，而这一行位于屏幕信息最密集的区域；`goal.showText` 可重新启用它，此时它会占用所有剩余宽度，并在边缘裁剪。该行始终恰好只有一行：换行产生第二行会每秒改变一次上方 transcript 的尺寸，导致全屏重绘。

恢复的 goal 会显示已运行时长；停止的 goal 会显示停止原因（`Paused`、`Blocked`、`Queued`、`Done`）。goal 完成后，即使 pi-goal 已清除其 entry，仍会继续显示 `Done`，持续时间为 `goal.completedLingerMs`。排队中的 goal 显示为 `+N`。

token 列统计 goal 启动后所有计费量。pi-goal 只在 checkpoint 结算 `tokensUsed`，因此运行中 goal 的总量会从同一个 session branch 重新推导——assistant usage 减去 goal baseline，包括 cache 流量，且绝不低于上一个 checkpoint。已停止的 goal 会保留停止时的总量，而不会吸收之后运行的内容。设置 token 预算后，该列显示为 `12.0k/50.0k`。`goal.showTokens` 可将其关闭；在实际产生计费前它也会保持隐藏。

语义 snapshot 的 `goal.clockRunning?: boolean` 由 Goal owner 给出真实计时状态；CC 只有收到 `true` 才从
`observedAt` 递增 elapsed。`false` 或缺失都冻结，不从 `phase: "active"` 猜测。
另一个可选字段 `goal.queueFrozen` 只有明确为 `true` 才显示 `· queue off`；不能从停钟反推冻结。
冻结 snapshot 的停钟仍由 owner 的 `clockRunning` 表达。legacy entry adapter 只用于旧记录。

它按自己的时钟刷新，因此该行不由 statusline 命令打印：后者只在 session 和 turn event 上运行，所以 elapsed timer 会在两个 turn 之间冻结。该行改为通过共享 event bus（`statusline:row`）交给 `pi-statusline`；后者将其追加在命令自身行的下方，并把前导 tab 后的所有内容右对齐——只有该 renderer 知道 resize 后的宽度，因此传递该行时不加 padding。

交接会获得同步响应，所以能立即知道 statusline 是否未加载：此时该行会先回退到此 extension 自己的 widget，再回退到 `setStatus`，而不会消失在无人接收的 event 中。

运行时间带有小时字段（`1h02m34s`），而不复用共享 duration 格式，因为 goal 的运行时间远长于单个请求。

`goal.placement` 可选择 `statusline`（默认）、`aboveEditor` 或 `belowEditor`；后两项会在此处绘制 widget，而不是交出该行。`goal.showText` 会重新添加 objective。`goal.refreshMs` 控制重新读取 entry 的频率。

## Extension 归属

### Built-in execution 与默认工具集合

CC 只注册 `registerToolRenderer` resolver，Main/child 均不注册 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 的 execution definitions。
Pi 保留原生定义，`pi-bash-timeout` 等 domain owner 可覆盖执行和 schema；CC 不再次注册 bash，也不放宽必填 timeout。
`presentation/claude-style-v1` descriptor 的 `tools` 为 `[]`，SA/Side 的 exact presentation guard 必须同步；不得保留旧的 7-tool execution ownership 假声明。

标准 profile 要保留原有 7-tool active 集合，必须由 profile owner 在 Pi settings 显式配置：

```json
{ "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"] }
```

Pi 1.5 的 native catalog 本来就提供这些工具，但 stock 默认 active 只有前四个。CC 不改 settings，也不调用 `setActiveTools`
去覆盖 `--no-tools`、CLI allowlist 或 SDK 的冻结选择；child 的工具可用性与 active 集合由 assembly/domain owners 决定。
覆盖 schema、7-tool 默认集合、只读 allowlist 和空工具集合均用真实 SDK 回归，确认不因 presentation 丢掉 grep/find/ls 或抢 execution owner。

第三方 extension 由 Pi 从实际 agent directory 的 `settings.json` 中恰好加载一次。CC Style 不会 import 它们的 factory、代理它们的 `ExtensionAPI`，也不拥有它们的命令、handler、工具、timer 或启动 lifecycle。它只在展示边界装饰返回给 TUI 的工具定义；执行和注册仍归源 extension 所有。

`importantTools` 控制独立展示策略：

```json
{
  "importantTools": {
    "askUserQuestion": true,
    "webSearch": true,
    "webFetch": true,
    "singleFileEdit": true,
    "todoList": true,
    "webDetails": "overlay"
  }
}
```

`todoList` 让 `todowrite` 风格的工具继续使用自己的 renderer，因此绘制 checklist 的 provider（Magic Context 自带一个）不会被折叠的 `Updated 1 todo list` 行取代。

todo provider 也可以使用自己的视觉语言，在编辑器旁保留自己的 panel。此 extension 则自行绘制任务，将其作为工作行正下方的一个可点击 component。spinner 可见时，`└` connector 将两个 component 连接成一个视觉区块。仍有工作时，同一个 Todo component 会在多次运行之间保持挂载，只去掉 connector；列表绝不会序列化到 `setWorkingMessage()` 文本中：

```text
✳ Composant... [G 1/10] 8m29s · ↑ 1.3k · esc to cancel
  └ ✓ 建立 fork 合并基线
    ■ 分析 bug 根因并修复
    □ 补齐回归测试

 ✓ 建立 fork 合并基线      ← the same component once the spinner stops
 ■ 分析 bug 根因并修复
 □ 补齐回归测试
```

最后一项完成后，编辑器上方的区块会被移除，statusline 显示 `✓ todo 3/3`。点击该 statusline segment 会在编辑器上方恢复完整的已完成 checklist；再次点击会把列表折叠回 statusline。

运行结束时，任务 glyph、字重和色调保持不变；只有 connector 会随 spinner 离开。点击 Todo component、点击其已完成 statusline segment 和按下 `Alt+T` 都会驱动同一个持久折叠状态。点击活动工具仍是独立操作，会打开只读 snapshot overlay。进行中的行使用较高字重和赤陶色，待处理行保持 dim，已完成行既加删除线又变暗——忽略其中一种效果的 terminal 仍能显示另一种。

已完成工作会继续绘制而非丢弃：只显示剩余工作的列表无法说明进度。长列表中大部分是已完成工作，因此行预算不足时会先压缩这些内容——最早完成的行折叠为单个 `✓ 7 done`，所有未完成内容都会保留，因为隐藏剩余工作的预算会让整行失去意义。

该列表可跨重启和 `/reload` 保留：它只接收实时工具 event，因此还会从 session branch 回读。全新运行时由 `session_start` 完成此操作；由于 `/reload` 重建 extension 时绝不会重放 `session_start`，读取还会挂接到 reload 后确实会到达的 event（`resources_discover`、`session_info_changed`）上，方式与重新激活 popup opener 相同。只有 snapshot 为空时才会重新读取 session，因此拿到列表后，这些 event 不会产生任何成本。两种 payload shape 都会读取（`{tasks: [{subject}]}` 和 `{todos: [{content}]}`）；分组词汇称作 todo 工具的任何工具都会为其提供数据，而不仅是名为 `todo` 的工具。

即使只有一次调用，信息量较低的已完成活动仍会保持精简：

```text
  Ran 1 shell command
```

已回答的问题会显示其结构化答案。Web Search 和 Web Fetch 显示准确的 query/URL、状态及耗时，完整结果则保留在 `Alt+O` overlay 中。内置 Edit 保持独立，并复用 Pi 的 native 行内 diff renderer。

### 项目记忆文件

普通 `read` / `write` / `edit` 的路径符合
`<agent-dir>/pi-cc-memory/projects/<64 位十六进制>/memory/<topic>.md` 时，
分别显示 `Read 1 memory` / `Saved 1 memory` / `Updated 1 memory`，明细显示去掉 `.md` 的主题名。
这是 pi-cc-memory 拥有的存储路径契约；CC Style 只按规范化路径识别，不 import 该包、不访问文件系统。
`write` 无论新建还是覆盖都显示保存，`edit` 显示更新。
同组同记忆目录的 `MEMORY.md` 操作归入主题摘要，不额外计数；单独操作索引显示
`Read memory index` / `Updated memory index`。其他目录、非顶层 `.md` 文件和其他工具沿用原显示。
这些操作复用 `grouping.memory`，优先于普通 edit 的单文件 diff presentation。

### Legacy Magic Context 展示

本仓不安装或迁移 Magic Context，也不依赖其源码、dist 或数据库。以下名称 adapter 和 `ctx-status` provider
只用于显示旧 session；包内测试直接调用公开 presentation registry，不加载外部插件。

旧 `@cortexkit/pi-magic-context` 工具记录使用自己的词汇分类，而不是回退到 `Searched for N patterns` / `Ran N tools`：

| 工具 | 折叠摘要 | 详情示例 |
|---|---|---|
| `ctx_search` | 已搜索 context | `Search memories + notes "spinner layout"` |
| `ctx_memory` | 已保存/读取/更新/归档/合并 memory | `Archive memories #12, #18` |
| `ctx_note` | 已保存/读取/更新/忽略 note | `Save smart note "retry later"` |
| `ctx_expand` | 已展开 context 范围 | `Expand messages §3§–§9§ · verbose` |
| `ctx_reduce` | 已将 context 丢弃操作加入队列 | `Queue context drops §12§–§18§, §21§` |
| `todowrite` | *(native)* | provider 自己的 checklist |

这些工具通过同一个名称路由多种操作，因此活动详情行和折叠后的 transcript 摘要都会读取 `action` 及其目标 ID。`ctx_note` 还会区分 smart note，`ctx_search` 会指出显式 `sources` scope，`ctx_reduce` 则会说明*已排队*，而不会暗示立即删除。分组开关仍位于 `grouping.memory`、`grouping.note` 和 `grouping.context` 下。

持久的 `ctx-status` custom entry 使用相同的归属划分。Magic Context 决定 transient 或 durable，并保留最小 fallback renderer；CC Style 通过 `Symbol.for("pi.claude-style.custom-entry-presentations.v1")` 提供紧凑行、语义颜色、柔和的省略号、点击打开的文本 overlay，以及 `Ctrl+O` 展开的正文。`pi-skills` 同样保留 `$skill` 与 agent-read entry 的内容和生命周期；CC Style 只把每个 skill 画成独立、不折叠的 accent `✦ Loaded skill name` 行，并在点击后用 Markdown TextPanel 展示当次加载内容。`pi-subagents` 保留 completion card 的 XML、digest、delivery 与单行 fallback；CC Style 只为 `subagent-completion-v1` 提供一行终态入口，忽略 `expanded`，点击后才在 Markdown TextPanel 中展示 Summary 与完整 Result。provider 租给当前 CC Style runtime，源 renderer 每次 render 时都会解析它，因此无论这些 package 以何种顺序加载都能收敛，teardown 也不会留下陈旧的 UI closure。命令标签（例如 `/ctx-embed`）使用更亮的 `customMessageLabel` 色调；分隔符和省略号保持 `dim`。

行内分组行、`Alt+O` overlay 和 `/tool-transcript` 适用于所有由 Pi 直接加载的工具。新注册的工具默认使用通用折叠展示；adapter 只负责改善其词汇。

工具展示使用 Pi 1.5 公开的 `registerToolRenderer` resolver，不再依赖私有 tool-definition 查找。resolver 只装饰 renderers，执行和注册仍归源 package；拒绝或失败会回退原 renderer。这个 public surface 由 typecheck、unit tests 和真实 host fixtures 验证，不伪装成 private probe。

### Pi 兼容边界

Pi 1.5 host surface 统一登记在 `src/compat/pi-1.3.ts` 中（保留历史文件名）。不安全的 instance 访问位于 `src/compat/` 下的 feature adapter 中；transcript 和 selector 策略不再重复声明 Pi 的私有对象布局。catalog 将 TypeScript 验证的已导出公共 member 与 private contract 分开；prototype contract 由 `npm run check-internals` 检查，instance contract 在实时 session 中运行。Pi 1.4 的 native thinking 会包在 `MouseRegion` 中，`assistant-message.childShape` 会同时校验 wrapper 的 `child` 和内部 Markdown 的 `defaultTextStyle`。测试会验证 catalog/probe 集合相等，因此添加没有 probe 的私有依赖会导致测试套件失败。

Probe 状态变化以内存为先。持久化通过异步 atomic writer 合并，并在 session shutdown 时 flush；render 和 input 路径不会运行同步 mkdir/write/rename 调用。Pi 升级后，`/internals` 仍是实时验证界面。

`@juicesharp/rpiv-ask-user-question`、`pi-native-search` 和 `@narumitw/pi-plan-mode` 如需启用，均由 Pi 直接加载；Magic Context 不在迁移 profile 中。它们的 package filter 不得排除 extension entry；现在使用 `autoload: false` 禁用 package 就会将其禁用，不再存在 CC Style 侧门。

代码搜索继续使用 Pi 内置的按需 `grep`/`find` 路径。未安装 FFF：其每进程、每 root 的常驻索引会在并发 Pi session 间成倍增加内存，扫描新 root 时还可能阻塞 TUI。Schema v2 会移除整个已退役 integrations override，因此旧 CC Style store 无法通过 CC Style 重新激活它或任何其他 extension。

## 开发

主入口由 Bun `--splitting` 打包，UIKit 内联，命令/overlay 的动态 import 仍在首次使用时加载。
Pi API、`typebox`、`conf` 和 `pi-runtime-contracts` 保持 external；UIKit 的跨包 geometry 通过已有 `globalThis`/`Symbol.for()` registry 协作，不依赖共享模块实例。
产物入口为 `dist/index.ts`、独立的 `dist/child.ts` 和诊断入口 `dist/src/internals.ts`、`dist/src/probes.ts`；构建先运行 source typecheck，不提交 `dist/`。

### Pi 1.5 loader 与产物契约

这些文件仍是 **Bun 输出的 JavaScript**，不是把生产源码复制到 `dist/`，也不使用新的 TypeScript 语言特性。
`.ts` 后缀选择 Pi 公开支持的 TS extension loader，让 bare Pi imports 绑定 host 的 virtual modules。
依据是 Pi 1.5 安装包的 `docs/extensions.md`（Available Imports / Writing an Extension），以及实际 loader 行为：
`dist/core/extensions/loader.js` 在 bundled CLI 中传入 `virtualModules` 和 `tryNative: false`，但其 Jiti 2.7.0
`eval_evalModule` 对 async ESM `.js` 仍走 native import。它因此可能解析到本包 devDependencies 中另一份 Pi，
即使版本同为 1.5.0，也不能安全 patch CLI 正在使用的 component prototype。

**入口、诊断入口、所有 shared/lazy chunks 和独立 child bundle 必须一起用 `.ts`。**
只改最外层入口不够：Jiti 对后续每个 `.js` ESM hop 都可能再次选择 native import。Bun 的 splitting 和首次使用
import 边界不变；`dist/config-storage.cjs` 不导入任何 Pi class，刻意保持 native CJS。
这不是 host patch 或通用 loader 框架，只绑定 stock Pi 1.5.0；升级后必须重跑真实 host gate。

消费者也属于这份契约：

- `package.json` 的 `pi.extensions` 指向 `dist/index.ts`；`src/child-capability.ts` 登记的 Main/child descriptor
  分别指向 `index.ts` / `child.ts`，继续校验 canonical path 和 hash。
- Subagents/Side 的生产 catalog 若校验固定 basename，必须同步为 `child.ts`；SDK fixture 和诊断 consumer
  必须同步引用 `dist/index.ts`、`dist/child.ts`、`dist/src/internals.ts`、`dist/src/probes.ts`。不能放宽校验或添加旧 `.js` shim。
- 真实 CLI fixture 同样用 `.mts` / `.ts` 入口保持 host 绑定，例如 `host-fixtures-extension.mts` 和临时 child wrapper。

证据：同一 stock 1.5.0 fresh process 中，source `.ts` 的 Assistant/User component identity 与 host 相同，旧 Bun
`.js` 产物不同；改用 Bun `.ts` 产物后恢复相同。此前“16 eager probes 都通过但 patch 错了 class”的误绿已由
`scripts/check-internals-host.mjs` 封住：它同时断言最终 CLI 的 component identity 和 compact patch 实际安装状态。
`npm run check-internals:host -- /path/to/pi-1.5.0` 是可重复门禁；`test:child-ui` 另验证 Main/child 的真实
identity、单次 ownership 与 teardown。无效后缀导致的降级不能用 source probe 或只改 snapshot 冒充通过。

```sh
npm run check
npm test
npm run typecheck
npm run build
npm run check-provider-errors:host -- /path/to/final/pi # 本地 faux provider；验证通用重复错误与重试 UI
npm run test:host-fixtures -- /path/to/final/pi
```

`check-provider-errors:host` 使用临时 HOME/agent/session 目录和独立 tmux socket，只注册本地 faux provider；
验证原始错误、retry 事件、fresh-process session 恢复及 TUI 聚合行，使用通用 `provider_log_id`，不访问真实 provider。
该验证使用通用 fixture，不依赖专用 provider 命令别名。

`check` 运行 typecheck、build 和全部单元测试。Host fixture 只从稳定的 bundle 入口加载运行时与诊断；
history anchor predicate 和 editor-slot geometry reader 从源码加载，分别通过 `Symbol.for()` 标记与全局 registry
识别真实 bundle 的对象，不依赖模块实例相同。Child UI harness 在启动前写入隔离的 v6 配置，Main/child 各自读取。

`test:host-fixtures` 先 build CC，再用真实 Pi 1.5 TUI、faux provider 和临时
agent 目录（显式设 `terminal.showImages=false`）跑分组工具、thinking 归批、nested、
用户消息折叠和围栏、图片入口（`read` 和非 read 工具；`showImages=true` 时 Pi 画图、CC 不加入口）、
`/session`、`/model`、运行中 Ctrl+T、跑完一轮后 `/internals` 无缺失几组场景，与 `test/integration/host-fixtures/`
的快照比对。快照只截被测区域（从第一个用户框或置顶问题条往下，不含 pi 启动横幅和底部 cwd、状态栏）；
路径、时钟、耗时和计数归一化，只有含这些值的行压缩横线和空白，其余行保持原宽度，框和面板变宽变窄会失败。
场景在系统临时目录下的短路径里跑，`CC_HOST_FIXTURE_ARTIFACTS` 指定的目录在结束时收到一份拷贝。
分组、nested、图片和用户消息还会在新进程里恢复同一 session，比对 live 与 hydrate 的 transcript；
运行中 Ctrl+T 断言 transcript 里的工具和 assistant 组件身份不变、工具进度照常到达。`--update` 重写或新建快照，
没有 `--update` 时缺快照算失败；`--only a,b` 只跑指定场景。改变可见行为的提交要同时更新快照。


鼠标动作只由组件的 `handleMouse` 定义，且只响应 Pi 判定完成的左键 `click`；press、drag、release、wheel 和 capture 继续归 fullscreen 宿主。custom-entry provider 组件也只实现 `handleMouse`，Magic Context、Skills、Processes、Subagents 的 v1 delegate 转发 `handleMouse`。详情面板继续由 UIKit 绘制。

## 同进程 child presentation

从 `dist/child.ts` 导入 `createClaudeStyleChildExtension({ target, taskName,
returnLabel, readOnlyStatusline, viewLifecycle })`，把返回值交给 SDK 的
`extensionFactories`。`target` 是 `subagent | side-chat`；两个目标都复用 Main 的
editor、transcript/working 和 statusline 安装器，只读取配置，不装 `/cc-style`、
Goal/Todo 或 model selector 控制面。Side 只接受 `side-chat` statusline contribution。
Subagent 每次绑定 TUI 时先同步挂载本视图的目录、model 和 effort 只读 CC 首帧，
再等待 statusline command 更新；command 慢或失败时保留该帧，不借用 Main 的分段。
Side factory 沿用原有首帧内容策略。
Main 在 `session_start` 用公开 `setFooter` 同步挂载同一模板，预留三行以保留
CP/MEM、cache 和第三行贡献项的布局；贡献项照常更新，不等 shell 成功。
Main 模板也保留 Fast 与 Todo slot；命令持续失败时，完成 Todo 的计数仍可点击展开完成列表。
命令成功后替换为真实输出，失败、超时或空输出保留上次成功帧；尚未成功时保留兜底帧。
Main 冷启动在 `session_start` 之前仍可能显示原生 footer；本轮没有增加私有启动接口。
`npm run test:main-statusline -- /path/to/pi-1.5.0` 使用隔离 profile 与零请求 fixture，
覆盖持续超时、成功后失败/空输出/超时、持续成功及 CP/MEM 更新；逐帧单独记录冷启动限制，
并要求 `session_start` 后的原生 footer 为零帧。
共享 managed host 正常初始化时在 native init、presentation/theme/draft 就绪后才提交渲染帧，
随后完整重绘；整个初始化超过两秒则显示当前画面并记录诊断，避免无限空白。
初始化期间 Alt+/ 也能返回，迟到的初始化不会重新显示已退出的子视图。

POSIX statusline command 使用独立进程组；timeout 向整个组发送 SIGTERM，宽限两秒后升级 SIGKILL；abort 使用 250ms TERM 预算。KILL 后最多再等 750ms，随后释放本端流与 timer/listener，保留直接 child 的 exit 回收。
view detach 和 session shutdown 会 await 所有在途 command。主动另建 session 的外部进程不受原进程组信号约束；这不是对任意脚本后代的隔离保证，详见 [statusline contract](./docs/statusline-provenance.md)。

`viewLifecycle.onAttach(callback)` 和 `onDetach(callback)` 注册回调并返回 unsubscribe。
Host 必须在每次新建 `InteractiveMode`、调用 `init()` **之前**调用 attach，返回 Main 时
**先 await detach**，再停止旧 mode。重复 attach 幂等；detach 不发 `session_shutdown`，
不结束后台 session。下次 attach 重建 presentation 并由新的原生 mode 绑定 context。
未传 viewLifecycle 时，presentation 与 extension session 同寿命。
旧 default OS export 与 env identity/attestation wiring 已删除，Main 负责 capability registration。
同进程 factory 默认不发布该 Main-shaped registry，图片展开由其原生 editor 自己处理。
child 不再安装全局 package-update suppression；Host 只调用 child `init()`。

CC 的 prototype dispatcher 由实际 receiver 的 owner 决定本地实现。owner 在 TUI widget
factory 取得公开 TUI，再用公开 Container tree 和 user-message.timestampBinding 已有的 chatContainer seam 绑定
receiver。消息进入 mode 时就通过已有 addMessageToChat seam 绑定归属，该步骤不依赖
user-message 装饰开关；历史与 streaming message identity 通过公开 session/event 补充。dispatcher
不会把后台 Main 的更新送到前台 child 的 timeline/typewriter。editor chrome state 属于
editor factory，statusline frame 按 session ID 保存 reload handoff，child 使用局部 frame。
custom-entry registry 保持原 shape，按生成的 component 分派 opener 并引用计数。
公开 ExtensionRunner 的 renderer lookup 用 session ID 识别归属；历史恢复早于 session_start
时，用 CC 自己已注册的公开 Markdown transformer callback identity 识别 runner。EntryRenderer
与 MessageRenderer 返回值使用 CC 自有 facade，在组件操作期间传递 scope；facade 不继承 Container，
不添加 children、键盘或焦点语义。公开成员按原对象实际有无动态转发，focused 的读取和写入、
wantsKeyRelease 的变化、getter/setter、class receiver、可选 dispose 与 symbol/layout 方法均保留。
原 renderer 返回的 Component 不做方法改写；必需 render 的临时装饰与 descriptor 恢复只作用于 CC
自己的 render 槽，因此 CC fullscreen frame hook 可与 frozen renderer 共存。MessageRenderer、tool renderers 和 Markdown
transformer 也在公开 runner 边界传递 scope；tool component 与 lastComponent identity 保持原样。
render 的 define/get/delete descriptor 操作也只落在 CC 槽，无论是 data 还是 accessor；默认
getter 独立读取原组件当前的 render。恢复 descriptor 后不保留临时装饰，也不调用原 setter
或改写原 descriptor。两种 accessor 在参数化对照和真正 CC fullscreen frame 中都验证冻结/可写形态。
Assistant/ToolExecution 的公开 render、invalidate 保留同步 owner scope，使 CC Thinking
内部 Markdown 延迟执行时仍使用本实例配置。CC provider 用 request identity 的 WeakMap
保留 lazy delegate 的归属，后续点击或 provider 替换在 CC 自己的 provider 边界恢复 scope。
第三方 Component 保留原对象与方法，支持 frozen/readonly renderer；不扫描任意对象字段。
没有新增 Pi private surface。
CC 不再隐藏 compaction/branch summary 和 skill invocation 的围栏，也就不给这三个组件传递 scope。
custom message/entry renderer 的组件由 facade 自己带 owner scope，`CustomMessageComponent` 的 render/invalidate 不再补丁。
只实现 `handleClick` 的组件不再桥接成 `handleMouse`（regular 已退役，Pi fullscreen 只调 `handleMouse`）。
原生 handled/capture/focus、目标坐标与 render:false 保留。没有 handleInput 的 facade 不会成为 keyboard focus owner。

验证（先 build 两个包）：

```sh
npm run build
npm run test:child-ui -- /path/to/pi-1.5.0
```

集成测试用公开 SDK、faux provider 和真正的 Pi binary 创建两个 session；Bun PTY/xterm
只发送固定按键，不调用外部模型。它分别以默认 user 样式和 native user 样式运行，每组
重建 child view 13 次，检查草稿/输入、原 CC 样式、Main 后台流式输出、释放后 Main patch
identity、outside-click、floating completion 和 geometry 释放。两组还覆盖 Skills 的三类正式 EntryRenderer、Processes 的正式 entry/legacy
message 与 tool renderer，以及 Subagents completion/mailbox。Main 首次进入 child 前、child、
Main 先释放后的 child 均执行这些入口；Main 原生 /reload 后重放历史 entry，再点击与替换 provider。
正式 entry 与 message 行使用实际屏幕坐标的 SGR press/release 验收，历史 entry 另保留直接 callback
验证。独立单击间隔超过 Pi 的双击选择窗口，不把双击当成第二次行激活。展开的 native
compaction/branch summary 与 skill invocation 检查正文、invalidate，并确认 CC 不再隐藏它们的
围栏。同时验证 frozen renderer 的原生 mouse handling/capture/focus，以及只实现 `handleClick` 的组件不再被桥接。
参数化的 native/CC 对照覆盖公开 Component/Focusable/EditorComponent 成员的有无、调用结果、
状态读写、private class receiver 和实际 VStack symbol 协议；真实 SGR 聚焦后分别输入、点击失焦，
对照 entry/message 两路的 native control 与正式 SDK renderer。经真实 v1 delegate 转发 `handleMouse` 且无
handleInput 的两路用例能点击打开正文，且不会被鼠标分发选成 focusTarget。
Magic Context 专属 production renderer fixture 已移除；legacy `ctx-status` 的 provider 及通用 lazy delegate
仍有独立回归，但不声称验证已退役 package 的生产 renderer。
另验证 native /session、Main model selector、通知、clipboard Markdown transformer 和真实 PNG
read 的 View Image 点击（fixture 显式设 `terminal.showImages=false`）。保留 lazy message delegate 的 render→click、provider 替换后点击、activity Thinking 的围栏隐藏、idle
sendMessage 的即时首帧（用 CC 认识的 `fork-update` 类型），合法 frozen message/entry Component 的 render/invalidate 与方法 identity，以及先释放 Main 后
child 仍可打开正文、最后释放 child 撤除 provider。
`CC_CHILD_UI_ARTIFACTS` 指定产物根目录，其中 styled-user/native-user 各有 terminal text/raw
和 JSON 结果。

Managed child factories must be installed when the execution session is assembled,
not on the first view entry. Their lightweight run recorder owns RunMetrics and
native run/turn separator entries for the session, including headless execution.
The same CC renderer is installed on view attach; it reads that recorder without
counting its events twice. View rebind/detach never resets pending run facts, and
session shutdown releases the recording listeners. Main keeps its existing event
order and working-row/divider handoff. No historical timing is invented on entry.

### SDK child entry ownership

`dist/child.ts` only exports the explicit named SDK factory. Main owns capability registration; the child factory reads no OS identity env and installs no Main commands. The obsolete default process wrapper has been removed.

### Fullscreen host 与 Pinned 配置迁移

全屏对话可浏览当前整条分支，压缩只改变模型上下文，不删除会话记录。恢复、新建、切换、fork、`/tree`、`/reload` 和设置重画先加载最近约 200 条记录。到已知内容顶部或点击 `↑ 加载更早的 N 条记录`，每次再补约 200 条，直到分支开头。批次对齐用户/summary 和完整工具调用结果边界，保留 Activity 分组，因此超长完整轮次可能超过 200 条。生成或压缩期间暂缓历史补载和卸载，空闲后继续。

每个视图以 **2000 条记录或 10000 个渲染行，先到者为准**控制组件驻留，保留视口所在批次及上下各一个邻批次；超过预算按距视口最远优先、同距按最近使用顺序卸载完整批次。底部只固定最近一个完整批次（约 200 条）及活动内容，`firstKeptEntryId` 之后更早的保留尾部也可以卸载和双向重载。选区覆盖的批次不卸载；这些保护区和单个超长批次可以超过预算，因此该数值不是进程 RSS 上限。

卸载处用空白高度锚点保留行位置和滚动条范围，滚近后分批重新构建；驻留组件保持身份，已卸载组件按保存的展开/折叠状态恢复。启动/资源提示及 chat 前缀内的选区保持原坐标；选区覆盖加载 header、跨越插入点或待重载空白区时，延后补载直至取消选区。通过现有 native append 边界绑定稳定记录 ID，使用公开 `setExpanded` 保存原生工具、摘要、skill/custom-message 展开状态；临时上下文分隔线不占真实消息的折叠键，Ctrl+O 的公开全局状态覆盖旧局部值；CC Thinking 按稳定 projection ID 保存折叠状态。第三方 renderer 自己的任意内部状态仍由其 owner 负责。锚点仅存最多 1024 字符的问题短摘要供吸顶行使用，不向搜索和复制提供已卸载正文。宽度变化时未重载锚点保持上次测量的高度和轻量记录位置；重载后按同一记录的新几何及局部偏移换算落点，吸顶跳转也携带记录身份。会话原始数据、图片与宿主分配器内存不随 UI 批次一起删除，RSS 也不保证立即归还操作系统。不要把组件驻留预算当作整个进程的内存上限；native/allocator 成本需另行测量。

所有压缩摘要留在实际发生的位置，只在**最新一次**压缩的 `firstKeptEntryId` 前插入「以上 N 条消息已压缩进摘要」分隔线；N 计该位置之前的 message entry，不含配置、custom entry 或摘要条目。现场压缩只重建常驻批次，保留未加载锚点；分隔线和摘要所在批次重载后按原始位置恢复，保留尾部不重复显示。全屏搜索只覆盖当前驻留部分，以前加载过但已卸载的正文也暂不参与搜索。上箭头输入历史独立从整条分支选取最近至多 100 个可入历史的用户输入，交给原生 append/editor 保留修剪与相邻去重；等 `session_start` 安装 editor 完成后单独填入，正文初始渲染和补载均不重复填入，也不清理活动工具状态。regular 模式保留 Pi 原生的上下文历史显示，不启用整分支和批次缓存。

新增私有边界 `history.renderEntries` 行为校验 `renderSessionEntries` 及现有 compaction dispatch 两个分支的同步 clear/render，真实 dispatch 也检查同步次数；读取 mode 的 `session/sessionManager/renderer`。`session` 只用于通过公开 `AgentSession.extensionRunner` 和已注册 Markdown transformer 识别 `/reload` 重画早于 `session_start` 的归属。`history.selectionAnchors` 校验补载涉及的 `selectionAnchor/selectionFocus/selectionInitialRange/lastClick` 内容坐标。复用已登记的 `chatContainer/addMessageToChat`、`handleEvent` 和 fullscreen frame/scroll metadata；两项均进入 `check-internals:host`，总数仍为 25。安装后运行中失配同样完整回退：取消补载、撤掉窗口和加载行，在 idle 且原生 dispatch 完成后，先恢复选区方法，再按 `buildContextEntries()` 同步 GroupStore/Activity 两份 projection 并调用原生 renderer；`/internals` 记录失配，regular 不受影响。

`bun test/integration/full-history.mjs /path/to/pi-1.5.0` 用合成会话和 faux provider 检查完整历史、补载选区/视口、两类现场压缩、reload、settings rebuild、tree、fork、new、resume、输入历史与运行中回退；另用 2800 余条记录检验卸载、双向重载、折叠状态、选区保护和多次压缩。`bun scripts/measure-history.mjs <pi> <extension> <fixture-dir> <results.json>` 使用临时 HOME 内可写的真实会话副本，只输出数字指标；副本 header 的 cwd 改到隔离工作目录，防止发现源项目资源。基线传改动前构建的 extension，改后传 `dist/index.ts`，记录 dist 内容 hash；一路访问开头后回到底部，滚动与打字阶段分别固定底部/跟随状态，记录实际帧数、峰值采样 RSS 与尾部 RSS 样本。不提交真实会话或终端文本。

`src/host/fullscreen/` 提供精确 editor geometry、面板外部点击关闭、每帧钩子、浮动补全、置顶问题与主题选区色。置顶问题直接合入帧，不建立 Pi overlay，所以滚动中的 transcript 选区仍跟随内容。深路径 layout import 失败时几何退回 UIKit 估算；选区 probe 失配退回原生反色。Main 与 child view 共用实现，detach 释放各自 owner。

从 settings.packages 删除 pi-pinned-layout 后重启。CC schema v6 首次启动将 `<agent-dir>/extensions/pi-pinned-layout/config.json`（优先，overrides）或 `pi-pinned-layout.json` 的 enabled、stickyUserMessage、floatAutocomplete、popupGap、minViewportRows 导入 `layout.*`。已有 CC 值不覆盖、非法值跳过，源文件保留并写 `.cc-style-v6.bak`；CC v5 store 留 `.schema-v5.bak`。备份失败则诊断只读，不写迁移结果。以后用 `/cc-style config get|set|reset layout.*`，补全来自同一 catalog；重启生效。若 settings 仍加载 Pinned，CC fullscreen host 不安装并在 doctor 报 degraded。

Above-editor widget 非空时，CC 用一个受 probe 保护的 `renderWidgetContainer` 包装去掉 Pi 的 leading Spacer(1)，让 Working、工具行与 Todo 连在一起；空容器和 below-editor 行保持原生行为。Main、Side、子 agent 共享该窄补丁；宿主形状变化时跳过安装、原生空行恢复。

测试/离线 probe 的 npm scripts 经 `scripts/isolated-agent.mjs` 在 import 之前设置临时 HOME 与 PI_CODING_AGENT_DIR；不要直接从默认 agent 目录运行会 import internals.ts 的测试。

置顶条在 Pi 原生选区着色后会恢复未被面板覆盖的那一行，所以正文选区滚到顶边时不会给问题条染色；选区与复制文本仍由 Pi 维护。浮动补全要等有效布局才隐藏 native 列表，帧接缝失配时退回原生补全。`/cc-style config set layout.enabled|stickyUserMessage|floatAutocomplete` 补全 true/false；`layout.popupGap` 为 0..100 整数，`layout.minViewportRows` 为 1..1000 整数，补全描述会提示范围。

长工具参数流式呈现只使用 Pi 公开的 renderer `state`、`argsComplete` 与 `executionStarted`：折叠摘要复用同一组件及其 wrap cache；`write`/`write_file` 的 native 或 inline 内容预览在参数未完成时最多展示前 4096 个 UTF-16 code unit 加省略号，截点避开高代理字符，前缀相同就复用组件。以每行 state 为弱键分别保存原生 call/result child 和 CC 包装；交给原生 renderer 的 `lastComponent` 始终是它自己的 child。完成、执行开始、路径或展开状态变化会重新渲染；完整参数始终交给执行器和 transcript。真实 Pi 1.4.0 write renderer 与公开 `ToolExecutionComponent` 的回归覆盖完成、执行、结果及 invalidate，并逐行对比 `7405261` 的最终基线（规范化终端样式、链接 escape 和行尾空格）。没有额外配置、timer 或 Pi private seam。

`npm run benchmark:long-write -- /path/to/pi-1.5.0` 在独立 fresh process 的临时 HOME/agent/cwd 内运行中文 50/100/200KB `write`，覆盖 native、CC Main、CC SDK child 与 CC + pi-perf。只生成本地 faux Responses 事件，调用原版 `processResponsesStream`，不访问真实模型或源 agent directory；普通 faux provider 不逐步解析 arguments，不能用于复现这个热点。每个 delta 强制一次 root TUI layout，终端输出只保留 38 行的 headless terminal 当前网格，记录 parser/delivery/layout、RSS/heap/external 与最终文件 hash；它是压力基准，不代表真实网络耗时。`CC_LONG_WRITE_ARTIFACTS` 指定产物目录，`CC_LONG_WRITE_SIZES`、`CC_LONG_WRITE_SCENARIOS` 选择矩阵，`CC_LONG_WRITE_DELAY` 添加每 delta 间隔；`CC_LONG_WRITE_PARSER=bypass` 只用于隔离插件成本，不能当宿主修复。benchmark-only import 的 pi-perf owner 仍拥有测量 registry/timer，不改变生产加载关系。

`npm run benchmark:write-preview` 独立量化 native 内容 formatter 的工作量：每 64 字符一帧，累计 5 万/10 万/20 万字符，重复 3 次取中位数，检查最终完整渲染相等；不包含 provider/parser 或 TUI 绘制成本。

## 交互回归清单

先在隔离 agent directory 显式启用需要的 package，并按下列实际入口检查；此清单不是已执行证据：

1. `/cc-style status`、`/cc-style doctor`、`/internals`：核对 feature/module、配置来源与 live probe；再用 `/cc-style config list transcript.assistantMessages.typewriter` 检查补全和生效提示。
2. 连续执行 `read`、`grep`、`bash`，检查 grouped 摘要、spinner 下活动行，点击单项并用 `Alt+O` / `/tool-transcript` 查看完整 Activity。
3. 执行 `ask_user_question`、`web_search`、`web_fetch` 和单文件 `edit`：答案、原样 query/URL、失败与 diff 不丢；在详情里检查完整输出。
4. 更新 Todo 并全部完成，检查 `Alt+T` 与 statusline `✓ todo N/N` 共享折叠状态；点击恢复完成列表。
5. `/model` 用 Tab/Shift+Tab 切 provider，再用 `/cc-style cache` 查看 cache 趋势；关闭 panel 后不留 watcher。
6. 用 `spawn_agent` 创建合成任务、`send_input` 追加工作、单独调用 `wait_agents` 等待，通过 `/subagents` 或 `/subagents <task-path>` 打开管理 UI，检查 Delegate pending 与成功冻结结果、无 args 回放及 completion 点击；进入 child 后 `Alt+/` 返回 Main。Side Chat 按已启用 package 的实际命令进入，检查 Main/child 不串帧。native child 的主题 capability gate 不得绕过。
7. `/session`、`/tree`、`/reload`，以及新进程 resume：检查历史、Thinking、grouped 详情与图片入口；改变源码后先 build 并重启，不以 reload 代替。

Delegate 的状态来源、args 省略和 pending 规则见 [工具呈现 contract](./docs/important-tool-presentation-spec.md#delegate-ui)。shell 的权限、会话路径及取消限制见 [statusline contract](./docs/statusline-provenance.md)。

### SDK/TUI 基准采集

SDK/TUI 基准的 `previewRows` 在最后一个 delta 后、toolcall_end 前采集，`finalRows` 在 prompt 完成且短暂的展示层 typewriter 排空后重新采集；两者通过公开 `renderNow` 后的实际终端网格采集，时间戳独立记录，检查执行后的 assistant 回复已结束、原生 renderer 无异常，并记录回复是否位于当前可见 viewport。`CC_LONG_WRITE_PRESENTATION=native|inline` 在隔离配置中启用 CC 的真实 native/inline 展开分支，可分别配合 `CC_LONG_WRITE_SCENARIOS=main,child` 验证 Main 与 SDK child；默认仍为原来的折叠矩阵。
