# pi-li-uikit

Pi 1.5.0 extension 共用的 TUI component。私有包，通过 workspace 依赖 使用。

## 应放在这里的内容

**TUI 渲染和 component。** 包括负责绘制的内容，以及随绘制对象归属的 input 处理。公开 subpath 包括：

- `text-panel`：规范的、可选择和复制的 editor-position overlay，支持键盘和鼠标滚动。共享 mount 会在 accent 标题线之上清出一整行宽度；frame 在正文前保留一行空白、不绘制垂直边框，footer 线右侧显示随宽度调整的导航提示。复制反馈会暂时替换右下角提示，显示为 `Copied N chars to clipboard`。正文默认使用 Pi 对话的普通 `text` 色调；调用方可选择更安静的 `thinkingText` 或 `muted` 色调、plain / Markdown / component 渲染，并限制正文高度；
- `editor-panel`：供 command UI 使用的 invocation-local editor-position screen stack；它与其他完整 panel 一样接收实际 screen origin，点击 panel 外部会关闭并吞掉该次 mouse report；item 设了 `searchText` 就按它过滤，没设仍按 `label` 加 `description` 过滤；
- `collapsible-block`：带受限 preview 的稳定 transcript summary；公开的无状态 `renderCollapsibleRows()` 提供统一的 `▸/▾` marker row、两列 preview、ellipsis hint 和 expanded section 基础语法，完整 panel 内嵌折叠内容时必须复用它，而非再绘制一层 frame；
- `selectable-collapsible-panel`：可选中、可折叠的 editor-position 列表 panel。UIKit 拥有开放式 frame、同为 `accent` 的顶/底 rule、右端 title/footer label（窄宽度截断保留）、稳定 item-id selection、`↑`/`↓` 选择、Enter/Space/点击折叠、viewport 自动跟随、滚动、复制与 mouse lifecycle；`renderItemDivider()` 提供相邻 item 间统一的 `borderMuted` inset rule，该行不属于 heading、不可选也不可点击；live reorder 按稳定 id 迁移 selection 并重新将当前 marker 带入 viewport，consumer 只提供 item identity 和 summary/detail rows；
- `tab-strip`：不持有状态的分类 tab，可选稳定 total、前后循环、固定 marker 列以避免选择时挤动相邻 tab，以及独立渲染的 divider hint；
- `search-select`：带可选分类 tab 的可搜索单选行。带 tab 的 screen 显示分类 total，预留最大分类高度避免切换跳动，将 Tab 提示置于底部 divider，并可在调用方指定的行打开。默认 selector 布局遵循 Pi model picker：提示、空行、`> ` 搜索 input、空行、选项、`x/y`、空行和当前选项的一行详情。焦点使用 accent 前景色，不绘制背景块；行可将 muted metadata 固定在右侧；choice 可给一个 `searchText`，让搜索按调用方的稳定字段匹配，而不是按渲染出来的行；
- `multi-select-table`：带键盘导航的对齐资源列，紧凑的固有列宽和固定两列间隔；采用与 SearchSelect 一致的 `→` 光标和 accent 前景色，`Space` / `a` 多选、`Enter` 激活、`v` 查看、`d` 批量操作；
- `conversation-panel`：全屏只读 Pi conversation viewport。调用方提供原生 Pi message / tool component；UIKit 拥有统一 accent frame、footer、明确的 follow-newest 状态、键盘翻页/半页导航和鼠标滚轮滚动；
- `process-panel`：SearchSelect 形态的 process list 和嵌套 live-output detail view。调用方提供 process snapshot、output 读取和 stop action；invocation-local component 负责过滤、选择、runtime refresh、output 滚动、follow-newest 状态和 stop 确认。详情两侧各缩进两列。加粗的对话色调 `Status` / `Runtime` / `Scripts` / `Output` 标签构成连续 metadata block；缩进 divider 将 `Output` 与对话色调 log 分开，保留 output 后再绘制匹配的 divider 和 line count，最后是共享底部 hint rule。process list 在当前宽度下计算稳定的 name / status / runtime 列，再将每个 command 左对齐到同一列。三列共用一次分配：status 列拿不到完整 `status` 的宽度时，整个 list 改用可选的 `statusShort`，并让它以自身宽度参与第二次分配，因此短 status 不会再被裁断，让位的是 name、runtime 和 command；没有 `statusShort` 的 item 行为不变。search 读 `searchText`（调用方给的稳定语义字段：name、ID、command/script），不读格式化后的行，resize 因此不改变同一 query 的结果。两个视图的 status 共用语义色板：live 为蓝色、success 为绿色、non-zero exit / error 为红色、timeout 为黄色。`title` 与 `listHint` 收 string 或 `() => string`；传 callback 时每帧读取，调用方的 live state 变了 panel 不用重建。
- `information-panel`：只读信息视图的 editor-position shell。它拥有 accent 标题 rule、完整 breadcrumb（窄时优先保留当前页）、右侧 footer hint、reader scroll、外部点击关闭且不穿透、鼠标 lifecycle 与高度策略。正文至少保留 3 行；整体高度最多为 terminal 的 70%，并继续受 editor slot 可用高度限制。调用方只提供正文、页面状态和领域快捷键；`renderKeyValue()` 只负责将 `key: ` 用 `muted` 渲染，value 与 Markdown 区仍由调用方按内容语义绘制。

  自己排布多个区域（分栏、内嵌 viewport）的 view 声明 `fillsBody: true`：shell 先按高度策略定下 row budget，把它作为 `renderBody(width, bodyRows)` 的第二个参数传进去，并把 frame 固定在那个高度；这时 reader scroll 归 view 自己，shell 不再滚动。不声明时第二个参数只是上一帧的预算，是提示而非承诺。`onMouse(event, controller)` 让 view 在通用 reader 滚动之前消费一个 mouse report，`controller.bodyPointAt(screenRow, screenColumn)` 把屏幕坐标换算成正文行与 panel 列；**外部左键仍先由 shell 关闭 panel**，这条边界不交给 view。
- `image-panel`：图片预览专用的 editor replacement panel。它保留 Pi `Image` 产生的 image protocol line 与后续空白预留行，不经过 overlay compositor；多图用左右键切换，`y` 复制当前图片的原始路径，`o` 用系统默认应用打开，Enter/Esc 关闭。调用方负责提供已捕获的 image block、原始路径、terminal capabilities 与 cell dimensions，UIKit 只拥有 preview UI、路径 action 和 focus lifecycle。panel 把 title、文件 label、MIME 和 fallback 原因当作不可信 terminal 文本，在进入标题、fallback 与 image protocol 前统一清除 escape sequence、C0/C1 和 bidi control；原始 path 只传给 clipboard 或 platform opener，不拼接 shell，也不直接写入 terminal。除 image protocol line 外，所有输出都不得超过 host 分配的宽度。该 panel 不声明 mouse ownership；regular/fullscreen 的 terminal viewport 仍拥有 selection 和 scrolling。

完整 editor-position panel 共用开放式 frame，不绘制垂直侧边框。它们必须声明 `wantsMouse`、接收 compositor 提供的 `setScreenOrigin(row, column)`，并把自身 frame 的实际宽高作为命中区域；外部左键只关闭最上层 panel，且同一 mouse report 必须在该 panel 内终止，不能穿透到底层 transcript、statusline 或 editor。包装完整 panel 的 component 必须透明转发 `wantsMouse`、`setScreenOrigin()`、`setAvailableHeight()`、`handleMouse()`、focus、keyboard input 和 dispose。`ctx.ui.custom()` 的 overlay factory 只返回 mounted component，不得在 factory 内先调用 `tui.setFocus()`：Pi 的 `showOverlay()` 必须先记录原 editor，再聚焦 overlay，关闭时才能把输入焦点还给原 editor。普通信息 panel 的顶部 rule 使用 `accent`，一行空白将它与内容分隔，正文采用对话 `text` 色调，随宽度调整的键盘提示放在 muted 底部 rule 的右侧。`SelectableCollapsiblePanel` 是需要持续 item selection 的专用变体：顶/底 rule 使用同一个 `accent` tone，title 与键位说明都嵌在各自 rule 的右端，正文用 `→` 标记当前 item。空间允许时，EditorPanel item description 从对齐 label 列之后第八列开始；窄时每次缩小一列，最小保留两列，因此 label 与说明仍清晰对齐。全屏 `ConversationPanel` 以及嵌入式 `TabStrip`、`CollapsibleBlock` 不自行声明 editor-position 边界；它们应继承 host panel 的 frame 与关闭语义。`LevelSlider`、`MultiSelectTable` 作为独立 `ui.custom()` panel 时必须经共享 editor-overlay mount 获取实际边界；gallery 内嵌时由 `UIKitGallery` 转发当前 component 的边界。

业务 action、session mutation、config schema 和 RPC / headless fallback 都留在消费它的 extension 中。`EditorPanel` 只拥有 view / navigation state。

**不应放入必须在多种 modality 中工作的 interaction flow。** `@narumitw/pi-tui-kit` 已经抽象了 TUI / RPC / headless，并为三者提供 test harness；必须在 `pi -p` 中回答的 menu 或 dialog 应放在那里，而不是这里。边界由 modality 决定，而不是由 component 与 flow 的区分决定。

## 形态及原因

该包以 `pi-runtime-contracts` 为模型：`private: true`、没有 build step、`exports` 直接指向 `.ts` source。每一项都是必要约束。

- **不 build。** public exports 直接解析到 source，不要求预先生成本库 `dist/`。compiled consumer 可能内联组件，也可能保留 bare-package import；须按消费者实际构建方式重建并启动 fresh process，不能把更新库文件等同于所有 bundle 已更新。不在本库添加伪 build step 或提交生成物。
- **`private: true` 与 workspace 依赖。** 消费者应明确引用本 checkout 的共享源码，不能假设 registry 中另一个同名/同版本的 copy 包含尚未发布的 API。保留 manifest/lock 的本地 dependency，安装后核对实际解析位置。
- **subpath exports，不设 root barrel。** consumer 只 import 实际需要的 component，例如 `pi-li-uikit/text-panel`；export 直接解析到 source。UIKit 的 bundler-mode TypeScript 可通过显式 `.ts` import 组合 shared component（例如 ProcessPanel 使用 EditorPanel 和 SearchSelect），而 compiled consumer 会解析并 bundle public subpath。root barrel 会过早耦合原本独立的 component。

  `text-overlay` subpath 暂时保留给仍有引用的 consumer；`info-panel` 和无消费者的旧 show helper 已删除。

  **新增 component 必须新增 `exports` entry。** 不要把 root package 变成所有 component 的隐式 registry。

- **clipboard support 保持轻量且异步。** 当前 helper 不从 coding-agent root 做 runtime import，避免只为复制功能额外加载宿主分发图；type-only import 不变。overlay 使用基于 `spawn` 的非阻塞 platform command，失败时回退 OSC52，不用 `execSync` 阻塞 TUI。具体首开/RSS 收益必须在目标 Pi 版本 fresh process 实测，不能沿用旧 checkout 的性能数字。
  现有 helper 在 SSH/MOSH 或 `PI_CLIPBOARD_OSC52=1` 时先尝试系统复制，再额外发直接 OSC 52（不包 tmux passthrough）；base64 长度上限为 100,000，超限仍保留成功的系统复制。变量未设或不等于 `1` 时不额外启用此路径。行为、验证边界与生效要求见 [OSC52_REPORT.md](./OSC52_REPORT.md)。

## 实例状态与跨扩展共享

组件可以拥有本次 invocation/instance 的滚动、选中、展开、焦点和复制反馈状态；不能用 module-level registry、cache 或 singleton 作为跨 extension 的共享业务状态。消费者可能 bundle 出自己的组件 copy，模块变量不保证进程内唯一。常量不受此限制。

跨 extension 协调必须使用有明确 owner、version、validation 和 lifecycle 的共享 contract；运行时协调由 `pi-runtime-contracts` 承担。UIKit 可以观察已发布的 editor geometry，但不拥有任务、provider 或配置状态。

## 测试

```
npm test        # node --experimental-strip-types --test
npm run typecheck
```

`test/support.ts` 是 `pi-goal/test/support.ts` 中 `createCustomSelectorHarness` 的逐字副本；后者也为另外三套 suite 维护自己的副本。

information-panel 测试固定 accent 标题 frame 与 3 行正文、terminal 70% 与 editor slot 双重高度上限、breadcrumb 左侧截断、外部点击关闭且不穿透、loading/cached/error state、`renderKeyValue()` 的 muted key、`fillsBody` 的精确 row budget（含 state 行占位）与固定 frame 高度、`onMouse` 消费顺序（外部左键先关闭）以及 `bodyPointAt()` 的坐标换算。editor-panel 测试固定 `A → B → Escape → A`、root close、replace semantics、每个 screen 的 search / selection 恢复、bracketed paste、外部点击关闭且不穿透、overlay 关闭后输入焦点回到原 editor 和 abort-safe async teardown。text-panel 测试固定 editor-position 放置、完整 editor 宽度、fullscreen layout 的 allocated-height 与 trailing-row 保留、滚动、clean-text copy 和 close behavior；collapsible-block 测试固定共享两列 row grammar、bounded preview、themed marker 与 payload reclamation 后仍至少保留 summary row。selectable-collapsible-panel 测试固定同色右端 title/footer rule、相邻 item 的 muted divider、divider 不参与点击/selection、窄宽度 label 保留、稳定 id selection、上下选择、Enter/Space/点击折叠、viewport 跟随，以及 live reorder 后 selection 迁移并保持可见。process-panel 测试固定 SearchSelect list grammar、右对齐 command、runtime formatting、nested / direct Escape behavior、follow-newest scrolling、confirmed stop、callback title/hint 的逐帧刷新，以及 `statusShort` 只在完整 status 放不下时替换、替换后不被裁断、缺省时行为不变、search 按语义字段在窄宽和宽宽给同一结果。

`showTextPanel()` 与 `showTextPanelComponent()` 始终经 Pi overlay 的 `ui.custom()` path mount。CC Style 会发布 fullscreen mode 中已分配的 editor rect；共享的 `editor-overlay` resolver 会在保持真实 editor 与 transcript 挂载的同时，将该 panel 放到完全相同的宽度、底边和可用高度。它会在 panel 标题线之上合成一行不透明空白，以便和背后的内容分开。panel 保持已有 content-height policy，并向上覆盖 message flow；below-editor widget 和 footer 留在原位。`done` 只关闭 floating view。wrapper 还提供 `setScreenOrigin(row, column)`，因此鼠标滚动、outside-click close 与 drag selection 使用合成后的实际位置，而不是猜测位置。

`showImagePanel()` 刻意使用 `ui.custom()` 的 non-overlay path。Pi 的 Kitty/iTerm image line 不能经过普通 overlay cell compositor：compositor 会填充图片预留的空行，regular TUI 随后无法恢复真实图片高度。ImagePanel 因而临时替换 editor，由 Pi 在关闭时恢复 editor 与原 draft；它接收调用方观测到的 terminal capability/cell dimensions，避免 linked package 各自的 `pi-tui` module cache 产生能力分歧。图片 label 只作展示元数据，必须经过 UIKit 的 terminal-text sanitizer；原始 path 不参与 terminal 输出，不被改写，只供 `y` copy 与 `o` open 使用。

`TextPanel.update()` 会在不重建 overlay lifecycle 的前提下替换文档与标题右侧 `note`，并请求 redraw。`note` 未提供时继续显示默认行数或 viewport 位置；live caller 可以用它显示独立于正文更新的动态 metadata。正文格式由 caller 显式选择：可能包含 Markdown 的内容使用 `format: "markdown"`，日志、命令输出和原始文件内容使用 `format: "plain"`。`showTextPanel()` 的 `onCreate` 暴露该 instance，`onFirstRender` 则在首帧 layout 返回后的 microtask 中触发一次；需要“先画缓存、再启动 I/O”的 caller 应在后者开始后台工作，不能把 component 构造误当作已经显示。
`TextOverlay` / `TextOverlayOptions` 暂时保留给 CC compatibility re-export。无消费者的 `InfoPanel`、`showInfoPanel()`、`showTextOverlay()` 与旧 host/context type 已删除。

## 只读信息面板规范

local extension 新增**以阅读报告、详情或日志为主**、且替换 editor 的信息面板时，必须通过 `information-panel` 的 shell 挂载；选择器、表单、确认与管理菜单不属于这一类，仍按其 interaction 语义选择 component。shell 的测试契约是：accent 标题线、标题内完整 `x1 > x2 > x3` 路径（宽度不足时优先当前页）、底部分隔线右侧键位、至少 3 行正文、`min(floor(terminal rows × 70%), editor slot available height)` 上限，以及外部左键只关闭当前 panel、不穿透到底层 UI。

分栏或内嵌 viewport 由领域 view 用 `fillsBody` 的 row budget 自己组合，shell 不提供第二套 scroll；共享的仍是 frame、高度策略、焦点、外部点击与 mouse lifecycle。

内容由领域包负责，不能让通用 shell 猜测：可能包含 Markdown 的区段必须使用 Pi Markdown renderer；日志、命令输出和原始文件内容必须按 plain 展示；一个 panel 同时含 metadata 与 Markdown 时分别渲染。`key: value` 用 `renderKeyValue()`，key 必须是 `muted`。涉及网络请求或文件读取时，有缓存先显示并标识缓存与时间，再在首帧后刷新；无缓存先显示 loading，再在首帧后读取。刷新失败时保留缓存并在 panel 内显示失败；无缓存时将 loading 原位替换为 error，不自动关闭。

UIKit 内的搜索、筛选和后续文本输入只能经 `printablePanelInput()` 接收可打印文本，快捷键和未识别控制序列必须消费，绝不能留下 `[D`、`[C` 一类字符。

## Pi 1.5 鼠标路径

Fullscreen 使用公开 `Component.handleMouse(TuiMouseEvent)`。Pi 解码鼠标、捕获 drag/release；UIKit 按 screen coordinate 处理 frame、选区与复制。完整 panel 消费 wheel（包括滚动边界），避免背景 viewport 随之滚动；不自行再次处理 Pi 合成的 `click`。共享 mount 转发 normalized event、实际 origin、可用高度、focus 与 dispose，保留 clipping 后的精确坐标。

regular 只保证不报错，不再有专用 DECSET 鼠标开关和位置估算。`panel-mouse` 中旧 parser 仅供测试构造 normalized event，UIKit panel 不再从 `handleInput` 解码 raw mouse。`InformationPanel.onMouse` 的领域 callback 继续接收既有 screen-coordinate shape。

Pi 只向命中的 overlay 派发事件，CC 的窄 fullscreen adapter 仅补 outside-left-press；geometry resolver 仍负责让 panel 底边贴住实际 editor rect。私有面由 CC 的 probe 负责。几何 registry 沿用 `pi.pinned-layout.editor-slot-geometry.v1` key，只有 `resolvers`，不再要求 regular 的 `providers` WeakMap。
