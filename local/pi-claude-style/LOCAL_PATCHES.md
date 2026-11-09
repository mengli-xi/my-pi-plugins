# 本地维护策略

本 package 主动维护自身实现，不跟踪独立 upstream merge 生命周期。现行行为见 [README](./README.md) 和 [contracts](./docs/README.md)；这里只保留未来改动容易破坏的取舍，不保存实施计划、旧审批或性能样本。

## 展示不接管领域

Pi 唯一加载第三方 factory，CC 只用公开 `registerToolRenderer` resolver 装饰 renderer。不得恢复 hosted loader、`ExtensionAPI` proxy、settings discovery、旧 tool-definition lookup 或 execution definitions。新工具默认通用 grouped，native 是需要说明理由的例外；adapter 拒绝/报错保留原生或通用语义 fallback，不改变执行结果。

七个 built-in 工具的默认 active 集合由 profile owner 用 `defaultTools` 配置，CC 不调用 `setActiveTools` 抢 CLI/SDK 的冻结选择，不放宽 timeout owner 的 schema。presentation descriptor 的 tools/providers/commands 为空，Subagents/Side exact guard 必须同步。

Goal/Todo/Processes/Capacity 的持久化、真实计量、认证和网络由领域 owner 负责。CC 只读带版本 semantic DTO，校验 session/shape/version；broadcast 配同步 request/reply，领域 owner 缺席时降级，不反向启动它。一个 channel 有一个 schema owner，一个 statusline key 有一个 producer；`processes` 领域归 Processes，展示贡献唯一归 CC。

保留 legacy session 词汇不等于迁移对应 package：Magic Context 的名称 adapter/`ctx-status` 仅展示旧记录，不依赖其 source/dist/database。通用 lazy delegate 回归使用已有 Processes 实现，不复制退役 package 的生产代码。FFF 不安装：其每进程、每 root 常驻索引会放大并发内存且争用 TUI；代码搜索仍用按需 built-in 工具。

## Runtime 与 UI 所有权

每次 factory 都有独立 `RuntimeScope/LifecycleManager`；所有 shutdown reason 退役当前 owner，逆序释放资源，迟到 import/continuation 检查 generation。共享 registry 只用于真正跨副本仲裁的带版本能力，按实际 prototype/receiver 与 owner token 分派。旧 teardown 不覆盖 replacement，不让后台 Main 更新前台 child。

`pi-li-uikit` 唯一拥有共享 panel/selection/viewport 原语，CC 拥有 editor chrome 和 transcript projection。editor decorator 返回同一 instance、只使用可用的公开 padding，窄终端或不支持的 editor 保留原生行为；不把装饰写入文本。clipboard image marker 必须遵守 editor 原子编辑边界，缺 seam 或缺文件回退原 path，Rewind 只使用有版本的 source projection/receipt。

内容行只响应 fullscreen 的 normalized completed-left-click `handleMouse`。host 拥有 selection、wheel、focus/capture 和鼠标模式；不恢复 regular 引擎，不把 handleClick-only 组件伪装成 mouse handler。第三方 renderer 可 frozen/readonly，原对象与方法 identity 不改，CC facade 仅转发实际公开 shape 与 symbol 协议。

Activity phase 只由可见非空 assistant 正文切分。Thinking 与工具共享真实顺序；完成后 timing 归后续 batch、末尾归最后 batch，不重复计时；无工具入口仍保持 standalone 可达。当前 Thinking footer 是本地 inline disclosure，历史详情走 panel。裁剪只释放 payload，不改历史行几何；fullscreen history window 的组件卸载用高度锚点和稳定记录 identity 恢复。session/model/tool 数据与进程 allocator 不在 UI 驻留预算内，不能承诺 RSS 硬上限。

## 配置与加载

私有配置只由 `ConfigService` 写入 `<agent-dir>/extensions/pi-claude-style/config.json`；agent directory 取公开 `getAgentDir()`，遵守运行环境，不固定 HOME。Pi settings/statusLine 仍归 Pi。损坏内容保留原字节，只读诊断；唯一强制恢复入口先备份再写新默认。revision/mtime 检测冲突而非自动覆盖，canonical 内容不变不写。

已有 schema v6 document 启动时轻量读取、完整校验；Conf writer 首次 mutation 才同步 require `dist/config-storage.cjs`。创建/迁移/恢复的原子写时机不延后。root `config.json` 仍用于旧 `CONFIG_PATH` 缺失时的 legacy fallback，不能因 integrations 字段退役删掉文件；不把该示例当现行 schema 默认。

迁移保留原始备份与回执，session naming 不再归 CC。旧 Pinned 的有效 fullscreen 配置只读导入 `layout.*`，已有 CC 值优先；备份失败 fail closed。layout mutation 按命令提示重启/重载，除性能开关外不假称 live。

`balanced/eager/minimal` 控制冷模块时序，不创建第二套 installer engine；Tier-0 pre-history hook 同步存在。lazy import 并发去重、失败缓存、generation-safe，已加载 ES module 不承诺卸载。statusline capacity 详情是有意保留的静态 panel 依赖：真实 compiled continuation 的 loader 可用性优先于消除这一个启动依赖。

## 调度、观测与兼容

Working、typewriter、goal、preload、expiry 共用 runtime scheduler，4ms 窗口合并 wakeup，各自仍按 wall clock 运行。typewriter 只缓冲展示 snapshot，tool/error 立即绕过，尾部有有限排空 deadline；压力来自 Markdown/render/event-loop，不因网络沉默降速。

`pi-perf` 唯一拥有全局 TUI/input instrumentation、采样 timer 与日志，CC 是 fail-closed subscriber 和有界 telemetry producer，不加第二个 wrapper。日志不写用户文本、参数/result 或提示词。关闭 CC consumer 不等于关闭 provider；微基准只报告实际测量层次，不宣称端到端或内存门禁通过。

Pi baseline 是 1.5.0，catalog 保留历史文件名 `src/compat/pi-1.3.ts`。25 个 private contracts（16 eager、9 live）与 probe 集合一一对应；公开 renderer API 由 typecheck/常规测试覆盖。health 先更新内存，再异步 atomic writer 合并落盘，shutdown flush；render/input 禁同步健康文件写入。prototype realm identity 必须与最终 host 一致，不添加 structural fallback 掩盖错误 class。

通知、版本和 package 更新走 Pi 原生。保留公开 `showError` 窄包装的理由是把最终 retry-failed 通知吸收到既有重复错误行，其余全部原样交还；info/warning 切断聚合。Working retry 四项 probe 只用于事件/indicator 与 session/view 恢复，失配保留原生重试或当前视图，不改 retry policy。provider activity 只读通用协议，不重引专用品牌 API。

## Build 与 native child

Bun splitting 保留首次使用 import，UIKit 内联，Pi API、`typebox`、主入口 `conf` 和 `pi-runtime-contracts` external。Main、child、诊断和 shared/lazy chunks 全部使用 `.ts` 后缀，内容仍是编译 JavaScript：Pi 1.5 Jiti async ESM `.js` 可能 native import 到另一份 SDK class，误 patch 错 realm。只改最外层入口不够，也不提供旧 `.js` shim。`config-storage.cjs` 不导入 Pi class，刻意保持 native CJS。

修改 TypeScript 或 source-only compiled consumer dependency 后显式 `npm run build`，新开 Pi process，不用 `/reload` 代替。`tsconfig.json` noEmit；生成 dist 不提交。`check-internals:host` 同时验证 eager probes、最终 component identity 和实际 compact patch，不能拿 source-only probe 冒充 bundle gate。

`dist/child.ts` 只导出 named SDK factory，Main 登记 capability。child 在 execution assembly 安装轻量 recorder，attach 安装 view，detach await 在途 shell 并释放 view，不结束 session。不能使用 `PI_OFFLINE` 禁掉 provider 网络；child 不安装 Main control、Goal/Todo、selector、external contributor 或全局 updater。return label 属于 editor chrome，不新增 footer 行，display name 不改 native session name。

CC Main 不要求 Pi 源码 patch。native child 仍遵守 `pi-session-runtime` 的 named-theme / theme-watch capability gate：缺少对应能力在停止 Main 前拒绝，不放宽为静默主题恢复。命名主题资源发现和真实 `ui.theme.name` 才能证明生效，仅出现在 `/theme` 列表不是应用成功。

Statusline 是真实 shell 边界，不是 sandbox，payload 带真实 session path；取消预算只回收本端 fd 和原进程组，不能追杀主动另建 session 的后代。完整数据、首帧、slot 与进程回收规则见 [statusline contract](./docs/statusline-provenance.md)。
