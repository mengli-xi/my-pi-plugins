# Pi 插件与共享库

本仓库用 workspace 管理可单独加载的 Pi 插件、共享运行库和可选宿主补丁；依赖用 bun 安装。

## 安装与加载

开发本仓库需要 Node.js 22.19+、Bun 1.3+ 和 Pi 1.5.0。Bun 是开发前提：依赖安装和 6 个包的构建都用它，多份 clone 共用 bun 全局缓存、不重复占盘；日常 `npm run` 脚本不变，用 Node 自带的 npm 即可。Node 直接运行 TypeScript 的测试建议使用 Node 24。**没有构建产物的插件不需要 Bun，也不需要安装本仓库依赖**（Pi 从本地路径直接加载，不读根 lock）；CC Style、Session Naming、Subagents、Processes、Goal、MCP Adapter 这 6 个包要先在仓库根用 bun 安装依赖并构建，使用它们需要 Bun。将下面的仓库地址占位符换成实际地址：

```sh
git clone <仓库地址> pi-packages
cd pi-packages
bun install --frozen-lockfile   # 全仓唯一 lock：根 bun.lock
# 仅这些包需要生成产物；使用前显式构建
npm run build -w pi-claude-style
npm run build -w pi-session-naming
npm run build -w pi-subagents
npm run build -w pi-processes
npm run build -w @narumitw/pi-goal
npm run build -w pi-mcp-adapter

# 从本地路径安装一个插件；Pi 直接加载，不复制、不安装本地包依赖
pi install "$PWD/local/pi-todo"
# 只在本次启动试用，不写 settings
pi -e "$PWD/local/pi-todo"
```

也可将插件绝对路径加入实际 `<agent-dir>/settings.json` 的 `packages`：

```json
{
  "packages": [
    "/absolute/path/to/pi-packages/local/pi-todo",
    "/absolute/path/to/pi-packages/local/pi-subagents"
  ]
}
```

以上方式来自 Pi 1.5.0 随包 `docs/packages.md`：`pi install <local-path>` 写个人配置，`--local` 写受信项目的 `.pi/settings.json`；`-e <package-path>` 仅本次加载。settings 中的相对本地路径以该 settings 文件所在目录为基准，不以启动 cwd 为基准。Pi 按包的 `pi.extensions`/`pi.skills` 声明加载资源，不自动加载全部 workspace。管理入口见 [pi-package-manager](local/pi-package-manager/README.md)。

**插件**注册 extension，可逐个启用；**共享库**只被 import，不加入 Pi packages。四个共享库由 workspace 依赖解析，不能把包目录单独拷走后假定相邻依赖仍可用。依赖只在仓库根按上面的安装命令装一次，不在各包重复安装或创建 lockfile。编译消费者更新后先重建并启动新 Pi 进程，不以 `/reload` 代替构建验证。

`fork/` 下每个目录是一个直接纳入主仓库的上游插件包，与 `local/*` 共用根 workspace 和 lock。原版保存在同路径的 `vendor/upstream` 分支，本地补丁在主分支维护；来源见各包 `UPSTREAM.json`，升级规则见 [贡献规范](CONTRIBUTING.md#fork-维护规则)。Goal 入口是 [fork/pi-goal](fork/pi-goal/README.md)。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。扩展在宿主进程中运行，安装前审阅源码；同进程能力校验不是 OS 沙箱。测试不读日常配置，不发真实模型请求。

## 包索引

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-ask-user-question](fork/pi-ask-user-question/README.md) | Fork 插件 | 结构化问答、预览、自填和独立 Chat/Explain 控制 |
| [pi-bash-timeout](local/pi-bash-timeout/README.md) | 插件 | 要求 bash 显式填写正数 timeout |
| [pi-cc-memory](local/pi-cc-memory/README.md) | 插件 | 项目记忆与冻结索引 |
| [pi-claude-style](local/pi-claude-style/README.md) | 插件 | 工具、Thinking、编辑器和默认状态栏展示 |
| [pi-effort](local/pi-effort/README.md) | 插件 | 推理档位滑杆与受控 ultra 提示 |
| [pi-fast](local/pi-fast/README.md) | 插件 | OpenAI Codex priority 请求开关 |
| [pi-goal](fork/pi-goal/README.md) | Fork 插件 | 持续推进目标、完成审计、预算与 durable 续跑 |
| [pi-li-uikit](local/pi-li-uikit/README.md) | 共享库 | 面板、选择器、鼠标和剪贴板组件 |
| [pi-li-uikit-gallery](local/pi-li-uikit-gallery/README.md) | 插件 | UIKit 交互式组件展示（开发用） |
| [pi-mcp-adapter](fork/pi-mcp-adapter/README.md) | Fork 插件 | MCP 网关、按需连接、OAuth、Apps 与 durable 后台结果 |
| [pi-model-capacity](local/pi-model-capacity/README.md) | 插件 | 容量、订阅窗口和余额观测 |
| [pi-model-prompts](local/pi-model-prompts/README.md) | 插件 | 模型规则、命名提示词与片段汇总 |
| [pi-native-search](fork/pi-native-search/README.md) | Fork 插件 | 公共原生搜索、可选 backend、DuckDuckGo 与网页抓取 |
| [pi-package-manager](local/pi-package-manager/README.md) | 插件 | 已配置包的启停、过滤和显式更新 |
| [pi-processes](local/pi-processes/README.md) | 插件 | 监督后台命令、滚动日志、进程通知与 deadline |
| [pi-rewind](local/pi-rewind/README.md) | 插件 | 会话裁剪、归档和校验恢复 |
| [pi-runtime-contracts](local/pi-runtime-contracts/README.md) | 共享库 | 不依赖 Pi 的版本化协调协议 |
| [pi-session-compact](local/pi-session-compact/README.md) | 插件 | 整会话压缩、恢复材料与原文检索 |
| [pi-session-inject](local/pi-session-inject/README.md) | 共享库 | 持久信箱、安全投递和 ACK |
| [pi-session-naming](local/pi-session-naming/README.md) | 插件 | settled 后自动生成会话标题 |
| [pi-session-runtime](local/pi-session-runtime/README.md) | 共享库 | 有效请求、SDK 装配与原生子视图 |
| [pi-side-chat](local/pi-side-chat/README.md) | 插件 | 同进程临时 Side 对话与提交即开的 BTW 面板 |
| [pi-skills](local/pi-skills/README.md) | 插件 | 显式技能补全、规则注入、完整读取记录与压缩恢复 |
| [pi-subagents](local/pi-subagents/README.md) | 插件 | 持久后台 Agent、Task 和完成投递 |
| [pi-terminal-focus](local/pi-terminal-focus/README.md) | 插件 | 终端失焦时隐藏主编辑器虚拟光标 |
| [pi-todo](local/pi-todo/README.md) | 插件 | 全量替换的待办与状态恢复 |

## 能力协议表

下表按生产代码实际注册/监听的事件、能力与共享 registry 整理。提供方链接是合同入口；“外部”指本仓不包含的可选扩展，不表示默认已装。session 生命周期事件属于 Pi，不重复列为插件协议；私有 patch 标记、内部 service cell 和持久 entry 标签也不冒充公共协作能力。

| 协议名 / 能力名 | 提供方 | 使用方 | 缺失时降级 |
| --- | --- | --- | --- |
| `rpiv:ask-user:prompt`、`rpiv:ask-user:blocked`（上游无版本兼容） | [Ask](fork/pi-ask-user-question/README.md) 发布当前问卷及等待状态 | 可选可信通知/观测方 | 无消费者仍正常提问，不读取其他插件存储 |
| `rpiv-ask-user-question:host-allocated-rows`（上游无版本 Symbol 兼容） | [Ask](fork/pi-ask-user-question/docs/hosts.md#宿主已分配行高) 读取 | 可信自定义 UI Host | 无标记按普通 inline/overlay 布局；仅影响行高，不授予执行权限 |
| `rpiv:ask-user:answer`、`rpiv:ask-user:answer-result`（上游无版本兼容） | [Ask](fork/pi-ask-user-question/README.md) 校验并接收，返回 verdict | 可信同进程 Host 桥接 | 无桥接由用户在面板回答；未知/已结束 toolCallId 拒绝，不授予网络或任意 loader |
| `prompt:fragments-v1` | [Model Prompts](local/pi-model-prompts/README.md) 发同步收集；Effort 贡献 | Model Prompts 汇总，Effort 接收请求 | 只有文件规则；缺汇总方时 Effort 只改真实档位 |
| `todo:snapshot-v1`、`todo:request:snapshot-v1` | [Todo](local/pi-todo/README.md) | CC Style | 不显示托管列表，Todo 内联与 /todos 不受影响 |
| `todo:changed`（旧兼容） | [Todo](local/pi-todo/README.md) | CC Style | 以版本化 snapshot 为主，不要求旧事件 |
| `goal:snapshot-v1`、`goal:request:snapshot-v1` | [Goal](fork/pi-goal/docs/protocols.md#goal-snapshot-v1) | CC Style、Compact | 无 Goal 状态/材料，不启动 Goal；不从 phase 猜 clock/freeze |
| `pi-goal:start`、`pi-goal:cancel`、`pi-goal:event:${runId}`（无版本旧兼容，默认 OFF） | [Goal](fork/pi-goal/docs/protocols.md#managed-rpc-旧兼容) | 可选可信 managed-run 调用方 | 无 owner 不假定接受；开关关闭拒绝新 start，不影响手动 Goal |
| `statusline:processes-snapshot-v2`、`processes:snapshot-request-v2`、`processes:open-request-v2` | [Processes](local/pi-processes/README.md#可选协作与降级) | CC Style | 无 processes 行/打开动作，不读私有存储 |
| `processes:managed-snapshot-v1`、`processes:managed-snapshot-request-v1` | [Processes](local/pi-processes/docs/MANAGED_EXECUTION.md#只读-managed-snapshot-v1) | 外部只读监管方 | 无消费者不影响执行；快照本身不授予控制或 ownership |
| `pi-mcp-adapter/status/v1` | [MCP Adapter](fork/pi-mcp-adapter/docs/extension-api.md) | 外部只读状态观察方 | 不显示 MCP 汇总，不连接服务器或读取凭据 |
| `pi-mcp-adapter:runtime-register:v1`、`pi-mcp-adapter:runtime-snapshot:v1`、`pi-mcp-adapter:runtime-tool-call:v1` | [MCP Adapter](fork/pi-mcp-adapter/docs/extension-api.md) | 可信外部扩展 | 无回复视为能力不可用，不绕过审批或自行补发 |
| `pi-mcp-adapter:protocol:v1` | [MCP Adapter](fork/pi-mcp-adapter/docs/protocol-extensions.md) | 可信自定义协议扩展 | 无 hook 明确拒绝，不暴露原始 client/transport |
| `pi-mcp-adapter:tool-approval-request`（无版本旧兼容） | [MCP Adapter](fork/pi-mcp-adapter/docs/tools.md) 发请求 | 可选外部审批方 | 无 claim 为 abstain；保留本包审批或拒绝，不默许执行 |
| `native-search:backends-request-v1` | [Native Search](fork/pi-native-search/README.md) 发同步收集 | 可选 backend；Host 显式向 SDK child 传发现通道 | 无贡献使用公共 provider/DDG，不探测未知 provider 的配置或凭据；冲突拒绝执行 |
| `provider:activity-v1` | [Runtime Contracts](local/pi-runtime-contracts/README.md) 定义 DTO；provider adapter 发布 | CC Style、Compact、SDK observer | 无队列/负载展示，压缩时钟正常计时 |
| `model-capacity:snapshot-v2`、`model-capacity:request-snapshot-v2`、`model-capacity:watch-v2` | [Model Capacity](local/pi-model-capacity/README.md) | CC Style | 不显示容量，模型选择和请求照常 |
| `model-capacity:register-adapter-v1`、`model-capacity:adapter-ready-v1` | [Model Capacity](local/pi-model-capacity/README.md) 与外部 adapter | adapter 注册 helper、CC watch 恢复 | 尚未准入不伪造成功；缺 adapter 不观测该 provider |
| `cc-memory:request:materials-v1` | [Memory](local/pi-cc-memory/README.md) | Compact | 空记忆材料，压缩继续 |
| `cc-memory:request:project-v1`（旧兼容） | [Memory](local/pi-cc-memory/README.md) | 外部只读旧消费者 | 无可用项目返回 null/reason；当前 Compact 不依赖目录接口 |
| `pi-session-compact:collect-recovery-v1` | [Compact](local/pi-session-compact/README.md) 发收集，Skills/Todo/Processes Main与Side/Subagents 回复 | Compact 与各 owner | 无回复注明未恢复；缺 Compact 时各 owner 独立恢复 |
| `pi-session-compact:collect-materials-v1` | [Compact](local/pi-session-compact/README.md) 发收集，[Skills](local/pi-skills/README.md#压缩材料与恢复协议) 等可选 owner 回复 | Compact | 技能材料为空，不读私有 binding |
| `pi-skills:compact-restore-request-v1`、`pi-skills:compact-restore-response-v1` | [Skills](local/pi-skills/README.md#旧独立恢复通道) | 外部旧恢复调用方 | 当前 Compact 不依赖旧回复；旧调用方不能假定规则已恢复 |
| `ui-pack.user-message-render-transforms.v1` | [Skills](local/pi-skills/README.md#消息装饰协议) 注册 transform；CC 提供 host，Skills 提供原生 fallback | CC/Skills 消息 renderer | 装饰不可用时保留原生显示，技能加载不变 |
| `statusline:row`、`statusline:refresh` | [CC Style](local/pi-claude-style/README.md) 状态栏 host | Effort、pi-fast、Memory、Compact、Subagents、Side Chat；CC 自有 Goal/Todo/Processes/Capacity 行 | 贡献无人接收不报错，不影响业务；Goal 可退 widget/setStatus |
| `child-capabilities-v1`（存储 key `pi.child-capability-registry.v2`） | [Runtime Contracts](local/pi-runtime-contracts/docs/child-capabilities-v1.md)；Timeout/CC/Processes/Native Search/pi-fast/已加载外部 factory 注册 | Subagents、Side Chat、SDK provider loader | 无声明不复制 factory；可选失败逐 owner 诊断降级，required 仍拒绝；工具来源经共享 realpath 规范化；文件/包身份校验不认证调用方；工具投影与外部 SDK grant 不变 |
| `presentation/claude-style-v1` | [CC Style](local/pi-claude-style/README.md)，通过开放 child 声明提供纯展示 factory | Subagents、Side Chat，外部 SDK 消费者 | child 使用 Pi 原生渲染，输入/历史/返回不变 |
| `pi.claude-style.custom-entry-presentations.v1` | [CC Style](local/pi-claude-style/README.md) | Subagents completion、Skills Loaded 行、Processes lifecycle；外部 entry renderer | 各 producer 保留自己的 fallback，不改变正文或投递 proof |
| `pi.claude-style.editor-image-source.v2` | [CC Style](local/pi-claude-style/README.md) | Rewind | 整体退为无路径 `[Image]`，不暴露临时文件路径 |
| `pi.pinned-layout.editor-slot-geometry.v1` | [CC fullscreen](local/pi-claude-style/README.md) | UIKit editor-overlay（含开发用 Gallery） | 原生布局估算，仍保持安全关闭 |
| `continuation-v1` / `pi.runtime-contracts.continuation.v1` | [Runtime Contracts](local/pi-runtime-contracts/README.md) | Subagents、Processes、[Goal](fork/pi-goal/docs/protocols.md#continuation-与-obligation)，外部 producer | 无 Wake consumer 时 producer fallback；共享库本身不调模型 |
| `process-wait-bridge-v2` / `pi.subagents.process-wait-bridge.v2` | [Runtime Contracts](local/pi-runtime-contracts/README.md) 定义，Subagents 注册 | 批准的 Processes child factory | 无合法 Task/grant 则 record-only，不恢复已取消任务 |
| `process-wait-bridge-v1` / `pi.subagents.process-wait-bridge.v1` | [Runtime Contracts](local/pi-runtime-contracts/README.md) 保留旧 API | 外部旧进程消费者 | 无 bridge 无协作 continuation；不与 V2 混用 |
| `goal-continuation-obligation-v1` / `pi.goal.continuation-obligation.v1` | [Runtime Contracts](local/pi-runtime-contracts/README.md) 定义，[Goal](fork/pi-goal/docs/protocols.md#continuation-与-obligation) 注册 reader | Subagents、Processes fallback | 无 reader 返回 none；unknown 保留 pending，不抢 continuation |
| `pi.subagents.producer-continuation-proof.v1` | [Subagents](local/pi-subagents/README.md) | Goal claimant | 无兼容 registry 时不 claim Subagents，producer 自行唤醒 |
| `pi-session-inject/mailbox-v1` | [Session Inject](local/pi-session-inject/README.md) | Goal、Subagents、Processes、MCP Apps/OAuth/Tasks、Compact 只读过滤及外部 producer | 这是共享库硬依赖；无 active owner 保留 pending，不私发 fallback |
| `pi.session-runtime.effective-context.v1`、`pi.session-runtime.session-assembly-realm.v1`、`pi.session-runtime.factory-loader-realms.v1` | [Session Runtime](local/pi-session-runtime/README.md) | Subagents、Side Chat、Compact、外部 SDK owner | 无 capture 按合同拒绝/重建；realm 冲突拒绝，不拿错 SDK 执行 |
| `pi.session-runtime.terminal-owner.v1`、`pi.session-runtime.terminal-gate.v1` | [Session Runtime](local/pi-session-runtime/README.md) | managed child view | 无 lease 不交接，保留 Main，不影响 headless |
| `pi.claude-style.internals.v1` | [CC Style 诊断 registry](local/pi-claude-style/docs/maintenance.md#调度观测与兼容) | Side Chat probe 贡献 | 无 CC 仅不汇总诊断；Side 自行验证，不授予执行或视图权限 |
| `pi.theme-watch.file-version.v1` | [可选 host patch](host-patches/pi/v1.5.0/README.md) | Session Runtime | 双面缺失允许原版配色降级并首次提示；单面/未知拒绝视图 |
| `pi.perf.ui-metrics.v3`、`pi.perf.telemetry.v1` | 外部 pi-perf；[消费约束](local/pi-claude-style/docs/spec.md) | CC Style、Session Naming（仅 telemetry） | 不采集，不另加全局 wrapper/timer |
| `permissions:ui_prompt`、`permissions:decision`（外部旧事件） | 外部权限 UI；[消费约束](local/pi-claude-style/docs/spec.md) | CC Working | 不暂停额外 modal 动画，不影响权限判定 |

## 可选宿主补丁

Main 和普通插件不要求宿主补丁。原版 Pi 1.5.0 也能打开 Subagents 的原生 child 视图，缺 CC 时仍可使用。`host-patches/` 固定上游 Pi 1.5.0 的可复现源码补丁，**不自动安装**；补丁让 child 视图获得命名主题文件的热更新。CLI 与 canonical SDK 须用同次构建的完整 peer graph，两面能力声明分别校验。范围、构建和回退见 [补丁说明](host-patches/pi/v1.5.0/README.md)。

## 验证入口

Pi 新版本的隔离兼容检查与可选版本应用见[升级 Pi](CONTRIBUTING.md#升级-pi)。

```sh
bun install --frozen-lockfile
npm run typecheck
npm test                         # 文档链接/可达性 + 各包离线测试
npm run check:goal               # Goal 包内检查；不把 Biome 扩到全仓
npm run test:integration          # 跨插件及缺失协作方降级
npm run test:integration:mcp      # MCP 与共享 transport、Goal/CC 的定向联测
npm run test:integration:ask      # Ask 与 CC 的问答呈现及可选依赖降级
npm run test:integration:stock-host # Bun PTY；原版无 CC child 视图
```

`npm test` 统一用主仓库 `git ls-files` 枚举已跟踪 Markdown（含 fork 文档），检查相对链接目标、GitHub 标题锚点以及从根 README 的可达性；排除 node_modules。脚本有断链、中文/重复锚点和孤儿回归；升级工具也有离线仓库和 tarball 合同测试。

补丁宿主入口须显式指定匹配产物：

```sh
PI_PATCHED_SDK=/path/to/build/source/packages/coding-agent \
PI_PATCHED_CLI=/path/to/build/source/packages/coding-agent/dist/bundle/cli.js \
npm run test:integration:patched-host
npm run test:patched-host -w pi-session-runtime
```

完整协作矩阵、额外依赖和三个 Subagents PTY runner 见 [integration](integration/README.md)。默认离线测试、真实补丁、真实 provider 和人工终端是不同验证边界，不能相互代替。沙箱不允许硬链接或嵌套 sandbox-exec 时，对应恢复/固定运行时测试需在沙箱外验证，不修改断言绕过。

## 贡献

先读 [CONTRIBUTING.md](CONTRIBUTING.md)，再按 [AGENTS.md](AGENTS.md) 从包 README 进入完整合同；[CLAUDE.md](CLAUDE.md) 使用同一组入口。
