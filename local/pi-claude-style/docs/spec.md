# Runtime、配置与所有权 contract

本 contract 适用于 stock Pi 1.5。用户功能和验证命令见 [README](../README.md)，工具细则见 [工具呈现](./important-tool-presentation-spec.md)，shell 边界见 [statusline](./statusline-provenance.md)。

## 展示与执行分离

- Pi 唯一负责 extension 发现、factory、tool/command 注册与执行。CC 不 import 第三方 factory，不代理 `ExtensionAPI`，不恢复 hosted loader、settings discovery 或 integrations control plane。
- CC 通过公开 `registerToolRenderer` resolver 装饰 TUI renderer，不修改工具 schema、参数、执行、模型可见消息、session entry 或原始 result。Main/child 都不注册七个 built-in execution definitions，descriptor 的 `tools/providers/commands` 为空。
- 标准 profile 若需要七个默认 active tools，由 profile owner 显式配置 `defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"]`。CC 不覆盖 CLI allowlist、`--no-tools` 或 SDK 冻结选择，也不放宽 domain owner 的必填 timeout。
- 新工具默认 grouped；native presentation 必须是明确且有理由的例外。工具特有文案集中在 `ToolPresentationAdapter`，不是散布的品牌或 tool-name 分支；adapter 拒绝或失败保留通用语义 fallback。对象 identity 的弱缓存避免每帧重复匹配，不创建第二个常驻 payload 索引。
- `pi-li-uikit` 拥有共享 panel、selection、viewport 和两列折叠语法；领域 owner 拥有内容、持久化和执行。CC 是 editor chrome 的唯一 owner，保留同一个 editor instance；prompt、history/session 标签和 Git 装饰不进入提交文字。
- transient 配置页、doctor/perf、历史详情和 `/session` 报告使用 editor panel/TextPanel，不因为展示方便而新增对话消息。已存在的持久分隔线仍是非模型上下文的 custom entry。

## Runtime 与加载

每次 factory 调用创建独立 `RuntimeScope`。`LifecycleManager` 统一拥有 feature disposer、widget、timer、subscription、opener、prototype lease 和 lazy task；所有 `session_shutdown` reason 都退役当前 runtime，按反向安装顺序幂等释放。`disposed` 后不得重新安装。可取消的 before-switch/fork 不提前清空当前 session projection。

可装饰的 native transcript 组件保留最近一次渲染行的独立数组副本（已有自有 render、不可扩展或无法守护内容变更方法的对象保持原样）。owner 退役后、宿主尚未卸载旧视图时，同宽且未失效的帧复用快照，避免原生 renderer 重排整段旧历史。快照随组件回收，不另建业务 payload 索引。

`invalidate`、内容更新、工具展开、Thinking 切换及其他公开内容变更会丢弃快照；主题变化通过 `invalidate` 生效。退役组件变宽或失效后持续走真实渲染，直到新 owner 认领；活跃帧一直执行当前 renderer，存入的数组不与调用方共享。没有公开入口的内部更新（如 ToolExecutionComponent 异步图片转换完成后调用私有 `updateDisplay`）不会使快照失效，只影响 owner 已退役但组件仍挂载的短窗口。

stock assistant 无 Thinking，或所有 Thinking 都由 CC 的 Activity/preview/展开布局接管且不再使用原生 Text 标签时，非空隐藏标签重置不改变其画面；仍执行真实 setter 和嵌套更新。渲染器仅发布自己已完成布局的标签独立性，不读宿主私有 `hideThinkingBlock`；仍使用原生折叠标签、缺失/未知 run 的行保持保守失效；含 Thinking 的行遇空标签也失效，因为原生可能直接移除该 run。

内容 key 在公开 `updateContent` 输入记录时生成，不持有可被调用方就地修改的消息对象。快照只复用相同输入及已证实与原生标签无关的行；后续 invalidate、Thinking 切换、padding 或内容更新仍会丢弃快照。

Thinking 标签由行组件呈现，不在绑定/清理时重复设置与原生默认值相同的全局隐藏标签，避免重建已挂载历史；宿主仍负责全局 UI 重置。分支投影重建前先退役已离开分支的 message invalidator，避免旧组件在恢复通知中重新引入已丢弃的 Activity。保留分支上的 Thinking 组件仍正常更新。

普通 UI/config/selector/diff 状态属于 installer/runtime，不通过模块全局 closure 继承。确需跨编译副本仲裁的 registry 使用带版本 `Symbol.for()`、owner token 和精确 receiver/prototype identity；旧 disposer 不得释放新 owner。statusline 最后成功帧按 session 保存有限 reload handoff，不保存 context 或 timer。

Tier-0 的 pre-history renderer hooks 同步安装。命令、overlay 和长报告按首次使用加载：

- `loading.mode=balanced` 默认只预热显式启用的类别；`eager` 在有效 context 和 idle delay 后预热；`minimal` 从不空闲预热。
- 并发 import 共享 promise；失败后允许下次请求重新加载，错误保留供诊断。完成后重新检查 owner、disposed、功能启用和 session generation，迟到结果不得安装进旧 UI。
- renderer/input/同步展示查询不启动首次 import；首次等待可显示加载状态并上报 import/wait/outcome。动态 import 只是推迟成本，不承诺卸载已加载的 ES module。

## 配置与持久化

`ConfigService` 是运行时唯一配置入口；`<agent-dir>` 由 Pi 公开 `getAgentDir()` 解析，遵守 `PI_CODING_AGENT_DIR`。私有 store 是 `<agent-dir>/extensions/pi-claude-style/config.json`，只保存 schema version、revision、overrides 和 migration receipt；Pi package/theme/model/statusLine 设置仍归 Pi。

- 优先级为受支持的环境逃生开关、用户 override、默认值。命令区分 active/stored/pending/source；除已实现的性能开关外，展示变更需 reload/restart，不因能写配置就声称实时生效。
- 默认值/schema/catalog/范围与补全保持同一来源。未知字段保留但不激活；错误不打印敏感值。
- 已有 v6 store 启动时轻量读取并完整校验，Conf writer 首次写入才加载；创建、迁移、恢复通过完整文档原子写入，不逐字段写中间状态。canonical 内容已相同则不写。
- mutation 通过 revision/mtime 拒绝外部修改冲突，不承诺跨进程锁或自动合并。渲染、输入和流更新热路径不做同步文件 I/O。
- 损坏 store 保留原始字节并只读诊断；显式 `/cc-style config reset-all --force` 先移动到带时间戳同级备份再恢复。headless 普通 reset-all 需 `--yes`。
- 迁移幂等且保留原始字节备份/回执：schema v2 删除 integrations；v3 移除 session naming（v2 backup 供独立 owner 只读导入）；v4 的旧布局移交已被 v6 fullscreen 接管取代；v5 迁移加载时序；v6 导入 Pinned 的五个合法 fullscreen 键，已有 CC 值优先，源不改，备份失败进入只读诊断。
- package 根 `config.json` **仍是运行资源**：`src/config.ts` 在旧 `CONFIG_PATH` 不存在时 fallback 读取它。旧 `integrations` 例子不是当前 schema 默认，也不会恢复 hosted factory；不能按“旧字段”误删整个文件。

## 语义协议与展示 owner

一个 channel 有一个 schema owner，一个 `statusline:row` key 有一个 producer。领域 owner 缺席时 CC 降级；CC 缺席时领域工具仍完整执行。

- Goal/Todo 消费带版本 semantic snapshot，broadcast 配同步 request/reply。未知版本、畸形载荷、跨 session reply fail closed；权威空 snapshot 不被旧历史复活。legacy parsing 只留在 `goal-status-legacy.ts` / `todo-state-legacy.ts`。
- Goal 只有 `clockRunning === true` 才从 `observedAt` 递增 elapsed；缺失或 false 冻结。只有 `queueFrozen === true` 显示 `queue off`，不从 phase 或停钟推断。计费和真实时钟归 owner。
- Todo 的点击、`Alt+T` 和完成 statusline slot 共用一份持久 fold state；全部完成后收进 `✓ todo N/N`，点击恢复完整完成列表；压缩旧完成项不能隐藏未完成工作。
- Processes 发布 V2 semantic snapshot/open protocol，CC 唯一生成 `processes` 展示贡献；不读取 process-domain 私有存储。capacity client 共享 statusline 与 `/model` 的 snapshot/watch，网络和认证归 provider owner；关闭 selector/释放 runtime 停止对应 watch。
- Working 仅消费 `provider:activity-v1`：版本/shape/provider/session 同时校验，local/upstream queue 分开，重叠等待只扣一次；`queuedMs` 优先于 `queueEnteredAt` 与本地接收时间。不新增品牌 API、执行或重试策略。
- 所有 provider 的 live TPS 至少使用 500ms 连续生成观测；精确/估算来源切换重建速率 baseline，terminal usage 结算总数而非 live sample。错误聚合只忽略明确动态字段，完整诊断和原始错误仍可检查；公开 `showError` 包装只吸收最终 retry failed，其余通知归 Pi。

## 调度与性能

用户消息框每个组件只缓存最近一帧；原生 render 和外部 transform 仍每次调用，原生行、宽度、主题、标题日期或折叠状态变了才重绘，dispose 或 owner 退役时释放。

正文 bullet 与围栏过滤同样每组件只缓存最近一帧，每次仍调用原生 render。原生行、宽度、marker/配色或主题/invalidate 变化时重算，dispose、owner 退役或 reload 时释放。

runtime 自有 working、spinner/shimmer、typewriter、goal、preload、expiry 共用 `UiScheduler` 的一次性 deadline，4ms 窗口共用 wakeup；按 wall clock 跳过过时动画，不补播。dispose 在 telemetry 退役前清空任务。

Typewriter 只合并展示 snapshot，不改 protocol/session。Markdown/render/event-loop 压力可延长下一帧并扩大追赶 batch，但 provider 间隙不触发降速；工具和 terminal error 立即绕过，尾部在有限期限排空。

`pi-perf` 唯一拥有全局 TUI/input instrumentation 和日志；CC 只消费 v3 并发布有界本地 telemetry。legacy v2、未知协议或 owner 冲突 fail closed，不叠加第二个 wrapper。日志不记录用户文本、参数/结果、命令或提示词。微基准、旧宿主 RSS 与单次最好样本不能代替 fresh-process TTY gate。

## Native child 与 Pi compatibility

`dist/child.ts` 只导出显式 SDK factory，不读 OS identity env，不注册 Main capability/commands，不用 `PI_OFFLINE` 禁止模型网络。execution assembly 时安装轻量 run/retry recorder，后台与 view detach 间继续记录真实事实；首次进入不伪造历史 timing。attach 在 native init 前，detach 在停止旧 mode 前 await，detach 不发 shutdown、不结束后台 session。

child 复用 transcript/working/editor/statusline installers，但不安装 Main control plane、Goal/Todo、model selector、外部 contributor 或 package updater。按实际 receiver/session owner 分派，不把后台 Main 更新送进前台 child。第三方原组件及 frozen renderer identity 保持；CC facade 动态转发实际存在的公开方法、属性与 symbol 协议，不扫描任意字段，不把 handleClick-only 组件桥接成 handleMouse。

Main CC 不要求 Pi 源码 patch。native child 仍必须服从 `pi-session-runtime` 的 named-theme 和 theme-watch capability gate；双面能力缺失时允许原版主题降级并首次提示，单面或未知声明仍在停止 Main 前拒绝。

Pi 1.5 catalog 保留历史文件名 `src/compat/pi-1.3.ts`。当前 25 个 private contract（16 eager、9 live）各有 probe、owner、影响与降级；public `registerToolRenderer` 不是 private seam，不恢复旧 tool-definition lookup。probe 失配保留原生行为；health 内存优先、异步合并写，shutdown flush。升级需用最终 binary 做 offline/live 与 component-realm identity 验证，不能用 source-only probe 冒充真实 bundle 成功。

构建和 `.ts` bundle loader contract、fullscreen history window、长 write preview、child UI 与 host gate 详见 [README](../README.md)。
