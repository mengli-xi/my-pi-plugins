# AGENTS.md

- 改代码前先读 [CONTRIBUTING.md](CONTRIBUTING.md)，里面是本仓库的硬规则。
- 包索引在 [README.md](README.md#插件)，能力协议表见[下文](#能力协议表)。
- 安装与批量安装见 [README.md](README.md#安装与加载)，统一入口为 `npm run plugins:install -- --all`，可加 `--dry-run` 预览。
- 改哪个包，就先读 `local/<pkg>/README.md`，需要细节再读它链接的 `docs/`；Fork 包从 `fork/<pkg>/README.md` 进入。

## 仓库结构

- `local/`：自有插件、共享库和开发用组件展示。
- `fork/`：直接纳入源码的上游插件，来源和本地补丁随包记录。
- `integration/`：跨插件联测、缺失协作方降级和宿主场景。
- `scripts/`：文档检查、隔离验证、升级工具和可复跑的性能基准。
- `host-patches/`：固定上游版本的可选 Pi 宿主补丁。
- `docs/`：仓库级设计与性能基线。

## Pi 兼容边界

[根要求](README.md#要求)中的 Pi 版本是当前 stock 验收目标。根 devDependencies 与 lock 精确锁定开发依赖，升级脚本的 `--apply` 同步 README 声明，离线测试检查一致性。包文档的「stock Pi 1.5」不代表其他补丁版本已验收。升级分级和统一入口见[升级 Pi](CONTRIBUTING.md#升级-pi)。

用 Node 直接跑 TypeScript 测试时建议 Node 24。

四个共享库由 workspace 解析，不能单独拷走包目录后假定相邻依赖仍可用。依赖只在根安装。编译消费者或共享库更新后，先重建并启动新 Pi 进程，不以 `/reload` 代替构建验证。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。同进程能力校验不是 OS 沙箱。测试不读日常配置，不发真实模型请求；[CLAUDE.md](CLAUDE.md) 使用本页入口。

## 能力协议表

下表按生产代码实际注册/监听的事件、能力与共享 registry 整理。提供方链接是合同入口；“外部”指本仓不包含的可选扩展，不表示默认已装。session 生命周期事件属于 Pi，不重复列为插件协议；私有 patch 标记、内部 service cell 和持久 entry 标签也不冒充公共协作能力。

| 协议名 / 能力名 | 提供方 | 使用方 | 缺失时降级 |
| --- | --- | --- | --- |
| `rpiv:ask-user:prompt`、`rpiv:ask-user:blocked`（上游无版本兼容） | [Ask](fork/pi-ask-user-question/README.md) 发布当前问卷及等待状态 | 可选可信通知/观测方、Perf（仅 blocked） | 无消费者仍正常提问，不读取其他插件存储 |
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
| `pi-session-inject/mailbox-v1` | [Session Inject](local/pi-session-inject/README.md) | Goal、Subagents、Processes、Scheduler、MCP Apps/OAuth/Tasks、Compact 只读过滤及外部 producer | 这是共享库硬依赖；无 active owner 保留 pending，不私发 fallback |
| `pi.session-runtime.effective-context.v1`、`pi.session-runtime.session-assembly-realm.v1`、`pi.session-runtime.factory-loader-realms.v1` | [Session Runtime](local/pi-session-runtime/README.md) | Subagents、Side Chat、Compact、外部 SDK owner | 无 capture 按合同拒绝/重建；realm 冲突拒绝，不拿错 SDK 执行 |
| `pi.session-runtime.terminal-owner.v1`、`pi.session-runtime.terminal-gate.v1` | [Session Runtime](local/pi-session-runtime/README.md) | managed child view | 无 lease 不交接，保留 Main，不影响 headless |
| `pi.claude-style.internals.v1` | [CC Style 诊断 registry](local/pi-claude-style/docs/maintenance.md#调度观测与兼容) | Side Chat probe 贡献 | 无 CC 仅不汇总诊断；Side 自行验证，不授予执行或视图权限 |
| `pi.theme-watch.file-version.v1` | [可选 host patch](host-patches/pi/v1.5.0/README.md) | Session Runtime | 双面缺失允许原版配色降级并首次提示；单面/未知拒绝视图 |
| `pi.perf.ui-metrics.v3`、`pi.perf.telemetry.v1` | [Perf](local/pi-perf/docs/protocols.md)；[消费约束](local/pi-claude-style/docs/spec.md) | CC Style、Session Naming（仅 telemetry） | 不采集，不另加全局 wrapper/timer |
| `permissions:ui_prompt`、`permissions:decision`（外部旧事件） | 外部权限 UI；[消费约束](local/pi-claude-style/docs/spec.md) | CC Working | 不暂停额外 modal 动画，不影响权限判定 |

## 可选宿主补丁

Main 和普通插件不要求宿主补丁；原版 child 视图沿用命名配色，主题文件热更新降级并首次提示。可选[主题补丁](host-patches/pi/v1.5.0/README.md)只适用于其固定上游，不自动安装；普通 Pi 升级不要求重建补丁。选择补丁时，CLI 与 canonical SDK 必须是同次构建的完整 peer graph，两面能力分别校验。

## 验证入口

Pi 新版本的隔离兼容检查与可选版本应用见[升级 Pi](CONTRIBUTING.md#升级-pi)。可重复的隔离性能基准、测量边界与当前结论见[性能基线](docs/perf-baseline.md)。

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

`npm test` 包含工具离线回归及文档链接检查：用 `git ls-files` 枚举 Markdown（含 fork、不含 node_modules），检查相对链接、标题锚点和根 README 可达性。

补丁宿主入口须显式指定匹配产物：

```sh
PI_PATCHED_SDK=/path/to/build/source/packages/coding-agent \
PI_PATCHED_CLI=/path/to/build/source/packages/coding-agent/dist/bundle/cli.js \
npm run test:integration:patched-host
npm run test:patched-host -w pi-session-runtime
```

完整协作矩阵、额外依赖和三个 Subagents PTY runner 见 [integration](integration/README.md)。默认离线测试、真实补丁、真实 provider 和人工终端是不同验证边界，不能相互代替。沙箱不允许硬链接或嵌套 sandbox-exec 时，对应恢复/固定运行时测试需在沙箱外验证，不修改断言绕过。

## Fork 维护入口

`fork/` 与 `local/` 共用根 workspace 和唯一 `bun.lock`。原版保存在同路径的 `vendor/upstream` 分支，本地补丁在主分支维护。每包的 `UPSTREAM.json` 记录来源，`LOCAL_PATCHES.md` 说明维护意图；导入、升级和验收规则见 [Fork 维护规则](CONTRIBUTING.md#fork-维护规则)。
