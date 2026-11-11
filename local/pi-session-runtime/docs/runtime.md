# 会话运行时合同

## 责任与模块

本库不注册 extension、命令或任务，不发现外部 provider。Subagents、Side 等调用方使用捕获、选择、seed、SDK 装配与原生视图 API；Compact 只消费捕获/选择，不创建 child。所有公开 subpath 直接导出 TypeScript，无 build 或根 barrel。修改库后重建编译消费者，并启动新进程。

## 普通 child factory

`child-factory` 共用声明式 loader、冻结证明与失败隔离；完整合同只写在 [child-capabilities-v1](../../pi-runtime-contracts/docs/child-capabilities-v1.md)。它不维护包名或固定路径名单，也不改变下面的外部 provider grant 机制。

## 外部 SDK provider

`pi-session-runtime/sdk-provider` 拥有精确 grant reader、冻结 proof 编解码、文件检查、binding fence 和批准 factory/observer 的装配。完整 JSON 与范围规则见 [provider 合同](../../pi-subagents/docs/sdk-providers.md)；库本身不加载该消费者的配置。

child registry 使用存储 ABI 2，key 为 `pi.child-capability-registry.v2`；V1 DTO/API 名称不变。ABI 1 不读、不覆盖，也不能授予新 SDK 权限。声明和 grant 元数据未变时复用缓存；`factory-loader` 跨 loader copy/SDK realm 固定 canonical 文件摘要，同路径代码漂移要求新进程。

## SDK 装配

`session-assembly` 创建 headless SDK child，独立拥有原生 SessionManager、内存 settings、resource loader 和 ModelRuntime。调用方提供冻结的 settings/model/tools、显式 extension factories、native writer 和 child-local shutdown 回调，也负责准入、deadline、中止和 dispose。

ambient packages/extensions 关闭，内置 extension 默认全禁，不改 cwd 或进程环境。settings 深拷贝；child 原生压缩始终开启，按所选模型窗口固定 `reserve=min(16384,window/8)`、`keepRecent=min(20000,window/16)`，包括模型 override。Task 和权限不由 settings 自动授予。

### 显式内置扩展

`ChildSessionAssemblyOptions.extensions` 接受 `readonly InlineExtension[]`，普通 `ExtensionFactory` 仍可用。`approvedBuiltinExtensions?: readonly ("codemode"|"tool-search"|"mcp")[]` 默认空；每个批准名必须恰有一个 `{name,factory,builtin:true}`。

未知/重复批准、缺 factory、重复 builtin 或未获批 builtin 均在任何 factory 执行前拒绝。llama.cpp 等其他名称不能批准。父 settings、factory 元数据或名称本身都不授予 builtin 身份。

```ts
const sdk = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
const builtinOptions = {
  approvedBuiltinExtensions: ["codemode", "tool-search"] as const,
  extensions: [
    { name: "codemode", builtin: true, factory: sdk.createCodemodeExtension({ mode: "on", models: false }) },
    { name: "tool-search", builtin: true, factory: sdk.createToolSearchExtension() },
  ],
  tools: ["read", "codemode", "tool_search"],
};
```

保持 `noExtensions:true`，仅从批准名生成 canonical `builtin:<name>` additionalExtensionPaths。其他 builtin、skills、prompts、context files 和 themes 不自动发现。公开 loader 为这些工具提供 canonical sourceInfo；批准只加载 factory，初始 active tools 仍由显式 tools 决定。

来源不等于沙箱或数据授权。消费者须检查权限并限制 factory options，例如 codemode 不应暴露目录时设 `models:false`。MCP 的 `sdk.createMcpExtension(...)` 默认读取配置并在 session_start 连接，消费者须拥有配置/transport 策略；本库测试提供空 servers 与拒绝连接的工厂，不访问真实服务。

### 唯一 SDK realm

本库跨原生 ESM 和 Root Jiti copy 共用一个不可变 child SDK realm。同版本不同物理 SDK 不等于相同 class prototype、回调和 registry；同一 CC factory 路径不能被另一个 realm 的 CJS cache 偷用。

`getSessionAssemblyPublicModules()` 返回 canonical 冻结表，含 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui`。首次调用发布不可写/不可配置的 `Symbol.for("pi.session-runtime.session-assembly-realm.v1")`，值为冻结 `{version:1,sdkVersion:codingAgent.VERSION,publicModules}`；后续同版本 copy 必须复用该表。

装配和 managed view 均经此表调用 SDK。`TerminalOwner.acquire()` 首次交接时动态取 getter，保存 canonical TUI keybindings 对象与 setter，返回时恢复同一个引用，不写调用方另一物理副本。空 Main binding 不初始化 SDK realm；import/getter 不创建 session/store/model runtime。异步 import 和 input drain 后重验 abort、lease generation、owner 与 disposal，再修改 Main 终端。

未知 schema、可变/畸形 holder、缺函数或版本冲突抛错，不替换、不降级。managed view 拒绝非 canonical AgentSession。registry 与 CJS cache 同寿命，跨 session 保留。调用方应保留首次 import 的 getter，并将其表传给 `loadApprovedFactoryModule()`；自己提供的 SessionManager 仍归自己，需要 class identity 时也须从 canonical namespace 创建，不克隆已有 writer。

`Symbol.for("pi.session-runtime.factory-loader-realms.v1")` 保存 `{version:1,paths:Map<approvedPath,frozen [codingAgent,ai,tui]>,digests:Map<canonicalPath,sha256>}`。每次 import/cache lookup 前声明该路径的三个 namespace；冲突可见拒绝，不返回错误 realm 的工厂。声明跨失败/shutdown 保留，因为部分模块可能已缓存。未知 holder 拒绝。此保护不代替 owner 的 path/package/hash/export 检查，也不提供任意多 realm 隔离；Core/TypeBox 映射仍由消费者负责。

本地回归用两个真实同版本物理 SDK、两个 assembly/loader 和同一 factory 路径，覆盖 native/Jiti 先后、重复交替、真实 session/runner/manager/mode identity、冲突 holder，以及 FakeTerminal 下 keybindings 的原引用恢复；不启动终端或 provider。

## 有效请求捕获

`fork-turns` 仅含冷 schema/parser 的共享 grammar；`effective-context` 无运行时 Pi import。`acquireEffectiveCapture` 以公开 SessionManager 对象为 binding identity 租用 session generation；同 identity 共用 capture/decorator。引用计数最后 release 清 observation/capture，Main shutdown/reload 必须 retire，即使另一个消费者仍持 lease。旧 release 不能碰新 binding。

每次业务 `context_with_system` 记录 RequestCandidate：leaf、选中 model/effort、active tool/capability 指纹、原生消息 provenance 与 run 的公开 signal；同时刷新公开扩展与 catalog provider。`streamSimple` wrapper 仅复制 normalized messages 和允许元数据，保留 receiver/options、原调用与原 stream，使用 AsyncLocalStorage 对齐准确调用。

捕获不含 auth options、headers、callback 或编码后的 wire payload，但消息可含正文、图片、thinking/signature、工具参数/结果和 usage，不脱敏。child 继承消息后可能发送给不同 provider；`none` 不继承父对话，仍有自己的 instructions/tools。

每个 session/generation 内存仅留最新 capture 和冻结原生消息副本；put/get 深拷贝，不是归档或 provider 沙箱。批准 factory 是可信同进程代码，完整 ExtensionAPI 和文件/grant 校验不隔离其网络、文件或传递依赖。

消费者在公开 `before_provider_request` / `after_provider_response` 调用 `lease.confirmRequest(ctx.signal)`；session、signal、async invocation、candidate、revision 必须全匹配。相同 anchor/transcript 不能证明 Main 归属，direct summary 不能消费候选。没有原生回调的请求不确认，retry 不重复消费已确认候选。每个新候选固定自己的 leaf，避免后续 transformer 移除的 response 被当 tail 复活。

不解析/修改 provider payload，不当 wire proof。按对象/函数 identity 发现 provider 替换，只在仍为自己的 wrapper 时恢复；不可装饰则 capture unavailable。`wirePrefix` 始终 unknown，不声称 cache hit。

共享 cell 为 `Symbol.for("pi.session-runtime.effective-context.v1")`，仅本库拥有。capture 表示 Main 最近实际发送的上下文，不是最新后台数据库，也不订阅任何第三方事件通道。有效性只看 session/generation、branch membership、projection reset 和 model/tool/capability 指纹。

未知请求变换要求有效 capture。`requestTransforms` 只在 fork 时比较当前 capture 的 provider hash 与冻结原生消息并缓存该 capture 的结果；新请求/失效清缓存。结构不合适的 capture 先 invalid，再判断 fallback，另一分支的证据不能授权原生回放；缺变换标记不证明 native-only。

本库只按原生 origin 精确比对消息身份，不识别第三方请求格式、包名或 `compaction.details` 来源。请求里的额外内容分两种情形：

- 只注入在请求里、分支里没有对应原生 entry 的前导或摘要：指纹和冻结原生消息对不上，变换标记不会是 native-only，身份无法证明，数值 N 拒绝；有有效 capture 时 `all` 仍返回 capture 原文。
- 以原生 `compaction` 或 `branch_summary` entry 落盘的摘要，不管 `details` 里写什么：本库看不出是谁生成的，按原生 compaction 处理，preamble 归属、数值 N 和 `all` 都照原生规则可用；旧 session 里遗留的这类 entry 同样如此。

## 选择与 seed

`native-child-context` 首次使用才加载。`selectEffectiveContext` 检查 generation、branch、selected/physical model（可用时）、effort、tool/capability 和 capture leaf 后的 compaction/context_edit/branch_summary reset；将有效 normalized request 与新增原生 tail 合并。pending assistant、不完整/重复/错配 tool batch 在最大可回放前缀处截断；`none` 不需 capture。

需要 capture 而不可用时抛 `EffectiveContextUnavailableError`，`code="effective-context-unavailable"` 且带机器可读 reason。库不静默授权 raw fallback；消费者自行决定是否提示跑 Main 或显式接受原生数据。已明确证明 native-only 可用公开 `buildSessionProjection`，但 `exactRequestPrefix=false`。

数值 N 计完整业务 turn（user、bash/custom 输入、branch summary），要求精确 provenance。只有明确 system/compaction/memory preamble 跨未选 turn 保留；普通 custom/bash 不是全局 preamble，body 跟所属 turn。未知 request-only 注入或含糊 user rewrite 使 N 不可用，all 仍可能可用。不从 raw history 补足 N。重复/自保留 compaction 和 context edit 先由 Pi projection 物化。

### 原生 seed

`buildNativeChildSnapshot` 接收完整 `EffectiveContextSelection`，写 fresh native session，追加 owner 隐藏 boundary 与可选冻结 model/effort，返回 JSONL 和 inheritedEntryIds。compaction/edit 已物化，不复制会复活 raw 正文的旧结构。重新分配 entry ID/parent chain，保留 toolCallId、thinking/signature、usage 和 nestedCalls。

首个模型不可见 custom entry 为 `pi-session-runtime-provenance-v1`：`{version:1,entries:Record<freshEntryId,"turn"|"preamble"|"body"|"unknown">}`。boundary 标 body；reopen/capture/再次 N 按此恢复归属，不猜摘要文本。unknown 保持 unknown，原生 compaction 可正常丢弃。用 inheritedEntryIds，不用数组下标识别继承行。

可选 writer 创建私有目录/文件，独占创建调用方路径；会话寿命、工具权限、清理和业务状态仍归调用方。`factory-loader` 按需 import Jiti，只加载调用方批准的 named export；按 host coding-agent namespace 和 canonical path 缓存模块，不缓存 options/session，不发现或授权路径。

## 原生视图与终端

`managed-interactive` 为已有 SDK runtime 创建一个可释放 InteractiveMode。其 extension 排在显式 presentation factory 后，将 lifecycle 传给参与方。`open(runtime,terminalOwner,inputPolicy)` attach、只调用 init 并等返回；close 保存展开草稿、await detach、stop、移除 UI callback、绑定 headless，不 dispose execution。调用方在 eviction/dispose/Main replacement/shutdown 前须 await close，不重放 Main session_start。child bindExtensions 会发两次 session_start，执行 factory 须幂等。

原生 init 在扩展绑定前启动 TUI。公开 Terminal writer 暂扣 synchronized-output frame，直到 init、theme/draft 和 onLoaded 就绪，同时允许终端协商/模式变更。正常就绪丢弃暂扣帧并全量重画；整个尝试（含 prepare/handoff）共用 2000ms deadline，过期释放 gate、重画并诊断，初始化继续。TUI 尚未暴露时显示保留输出，不能无限黑屏；只有该超时路径可出现原生 footer。

绑定前返回键也有效。close 取消 init，不等待未完成 native init/bind/onLoaded；每个 continuation 复查尝试级 abort，runtime/session facade 阻止迟到 bind。退役 terminal 保持输出门，不能污染 Main/下次视图。取消的 input drain 不得 acquire/clear 新 lease；放弃初始化时同步启动但不 await headless rebind，迟到结果不重绑/重画旧 mode。正常 close 仍按原 drain 顺序。

`terminal-owner` 从 widget factory 获取 Main 公开 TUI，不替换 editor、不调用 Main mode.stop。`pi.session-runtime.terminal-owner.v1` 全进程只准一个 child lease。Main/child Terminal 的 write/title/progress/program-status 被 gate，返回恢复 Main 最近语义状态；keybindings/theme 用公开 API。任意 stdout 写入不隔离；Main 须在 session_start 安装 gate。

gate 精确引用释放，不覆盖新 gate/第三方 wrapper。退役 wrapper 透明且不重放；直接相连的退役 gate 可跳过，全部释放后恢复原方法；不透明第三方 wrapper 保留。函数局部 `Symbol.for("pi.session-runtime.terminal-gate.v1")` 保存 `{version:1,previous:Function,retired:()=>boolean}`，未知/坏值不解包。只有当前前台 gate 恢复自身状态。

`process-ownership` 比较 child init 前后公开 listener 引用多重集。Pi 1.5 为 SIGTERM/SIGHUP/uncaughtException 及 stdio error 各加 handler（SIGHUP 仅 POSIX）；先验证全部差集，再仅移除新增函数。缺失/未知 listener 拒绝 entry，native stop 清自己 handler。Main 独占信号/崩溃处理，shutdown 等 child cleanup；不是 private-field probe。

### 输入与生命周期

`input-policy` 包装原生 editor 的公开 onSubmit/terminal input。调用方提供唯一命令表、禁用动作、durable admission、busy/interrupt/return。completion 与命令表同源。原生提交先清文本，adapter 立即恢复展开正文，只有准入成功才清；拒绝保留以便重试。

Ctrl+C idle 返回、busy 中断；非空 Ctrl+D 原生删除，空 Ctrl+D 须独立按压；Ctrl+Z 禁用。只过滤本策略接管动作的 Kitty release/repeat，其余事件原样交 Pi。Esc 走公开 CustomEditor.onEscape，overlay/autocomplete 优先。公开结构校验不依赖跨 Jiti 的 class identity。解析不读写全局 keybindings，autocomplete 属实例；匹配动作使用真实 editor 传入的 manager。

只保留当前 presentation 和 child draft；返回后不保存 child undo/history cursor/scroll。Main editor 对象存活所以其状态保留。跨物理 SDK 的 theme callback ownership 不保证立即回收 heap。

`ManagedInteractive(report,interrupt)` 必须收到 session-owned Host interrupt；交互/headless 的 ctx.abort 都走它，关闭 view 不禁用后台 abort。`close("quit")`、TerminalOwner restore/dispose quit 只释放，不重启 Main、不恢复 progress、不重画，因为 Main /quit 已停 TUI。普通返回/replacement 保持 stop/detach/headless/restart；pending 普通 return 可被 quit 提升。

可选 `configureMode(mode)` 在 init 历史渲染前调用，返回的 disposer 每次 close（含失败）都执行；只改该实例，失配须在继承历史渲染前拒绝。`InputPolicy.onInput` 可先消费键，`emptyDelete` 只替换空 Ctrl+D；省略保留默认行为。

`yieldTerminal(action)` 暂停当前视图输入/TUI，让外部编辑器使用终端。close abort 并等 action，正常结束只恢复同一前台 TUI，并发 close 则交 Main handoff；消费者须尊重 AbortSignal。

## theme-watch 与原版降级

`TerminalOwner(tui,ui,readThemeSetting)` 接收 live getter。只支持显式单个命名主题；automatic light/dark pair、隐式默认、匿名 in-memory theme 在 Main stop 前拒绝，不修改设置。ui.theme 是 live proxy，不是可传回的 Theme 实例；进入用 getTheme(name)，child 接收同一命名设置。

首次 SDK import 后、input drain/Main stop/前台转移前，分别检查 Main `ExtensionUIContext.themeWatchCapability` 与 canonical SDK `THEME_WATCH_CAPABILITY`：

- 双面精确 `pi.theme-watch.file-version.v1`：按名恢复主题并装 cache-only repaint bridge，文件版本 reload 由 SDK 拥有。
- 双面 undefined：原版 Pi 1.5.0 可交接，沿用命名配色，不装 bridge，不保证文件热更新；native init 后及返回时若同名则不重复 setTheme，避免原版 FSWatcher 同步关闭慢路径叠加。首次交接经 Main notify 提示一次，同进程跨 binding/consumer 去重，指向补丁说明。
- 单面声明、未知值（含 null）或 getter 抛错：保留 Main、拒绝交接，带安装/重建/重启指引与 cause；不得 shim 伪造 marker。

headless/tool-only 不要求 marker。不读 private theme/controller，不改 prototype，不另写 loader。补丁安装见 [host patch](../../../host-patches/pi/v1.5.0/README.md)；CLI 与完整 canonical SDK peer graph 须同次构建。

patched 路径的引用所有、non-persistent watchFile bridge 只在变化后通过公开 setTheme 重应用 Main cache，不读/parse 文件；SDK 独占 file-version reload、cache invalidation 和原生 repaint。路径取公开 getAllThemes，Main 输入后观察命名变更；replacement/disposal 精确移除自己的 listener/watcher。全进程 registry 记录 patched entry，使 replacement Main 仍装 bridge。不要求两个 loader 共享 callback/cache。自动/匿名主题需上游提供 owner-scoped theme-state API 才能扩展。

## 验证

默认测试只跑 stock 可用的离线测试；`test:patched-host` 单独跑 session-realm、terminal-frames、terminal-owner，要求匹配补丁 SDK，缺失明确失败。原版合同覆盖双面缺失、一次提示、同名恢复跳过；marker fixture 只覆盖协议分支，不代替真实补丁验证。

根 stock-host 联测用真实原版 SDK/CLI、faux 和 PTY 打开无 CC child，检查 deadline、主题、Main editor identity 与零额外请求。核心回归还覆盖 fork/seed 矩阵、capture ownership/失效、嵌套 provenance、真实公开 SDK 的负控，以及 model/tool/branch 漂移、撤销 grant、文件漂移、单前台、草稿、overlay Esc、拒绝输入保留、迟到初始化、quit 不重画。所有会话和终端端口隔离；不证明远程缓存、provider wire、真实旧 producer DB、内存性能或人工 IME。
