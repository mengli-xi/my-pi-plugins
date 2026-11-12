# 本地维护意图

- Upstream：`npm:pi-mcp-adapter@7.0.1`
- Repository：<https://github.com/nicobailon/pi-mcp-adapter.git>
- 当前 host 合同：stock Pi 1.5；无额外 Pi patch。

本文只记录当前 patch 的 WHY 和兼容规则。功能用法与完整合同从[README](README.md#文档目录)进入；上游 `main` 的 Unreleased 项不是本包的默认组成，不能据此宣称其 security 修复覆盖 7.0.1。

## 逐文件编译与按需加载

Pi 从 `dist/index.js` 加载，runtime 逐文件 transpile、不 bundle，依赖 external，保留 Pi/TUI/native/optional dependency 的正常身份与解析。构建清理旧输出，复制 runtime assets 并生成 public declarations；dist 内最小 manifest 不注册第二份 extension。生成物不提交，源码和 source-only library 变化后必须显式 build，再开新 process。

冷启动不应为未使用的功能加载完整实现。配置和纯 schema/settings 检查不能初始化 classifier、OAuth、Apps 或 UI runtime；词法搜索与普通调用不需要 semantic implementation。semantic、Apps、panel/setup、OAuth 的动态 import 保持独立，await 后仍检查 operation owner/signal。严格的同步 argument validation 不为冷启动优化改成异步。

Mailbox 使用 `pi-session-inject/mailbox-v1/light`，实际 mail/recovery 才加载共享 engine。这不是“首次启动绝不连接”：metadata 缺失时的默认 discovery、eager/keep-alive 和 Executor catalog 初始化仍按功能合同执行。不把旧 host 的 import 或 TUI benchmark 当当前 host 测量。

## 路径与 metadata 的身份

目录来自 Pi 公开发现接口、当前进程的真实环境和显式配置；Claude/Codex imports 尊重 override。不能因 doctor 使用的 shell `pi` 或短命进程环境不同而读写另一个 agent 的状态。

Metadata cache 以稳定文件版本信号复用已解析结果，同版本不反复读/parse；规范内容相同时不重写。读取失败不能把未知状态当空 cache 覆写已有文件。TTL、config identity、private metadata 和当前 session catalog 的区别见[工具](docs/tools.md)。

## Durable delivery 只有一个 owner

Apps、后台 OAuth 与新增 Task 结果共用 `pi-session-inject` 的 mailbox producer 和 durable acceptance；不保留独立 native queue、Task wake 或第二份 pending store。共享库负责 projection/recovery/branch fencing/wake coalescing，Adapter 负责 source identity、consent、current runtime/server/credential guard 和业务取消。库是硬依赖，不通过 import 其他插件获得投递能力。

前台 intent 的 ID 与完整 text/image payload 在异步工作前冻结；重试复用同一 ID 与 bytes。ACK 只能在 durable put 接受后成功。Resource/auth/task 等待不能把结果移到新 session/branch；retired owner 拒绝新 action。恢复不重放 tool、UI action、OAuth 或用户命令。Native proof 必须 exact match，不把历史 entry 或缺失的旧 volatile outbox 编造为新投递。具体合同见[mailbox](docs/mailbox.md)。

OAuth success 在投影前根据**当前配置 URL**与**实时 secure store**只读重检，不靠进程内 token cache，也不触发 refresh、import、compact、认证或凭据删除。凭据成功与通知接受是两个结果，后者失败必须可见。

## 凭据只归其公开 owner 管

生产路径不提供 fake keyring/test store 开关；测试通过测试侧替身隔离，不让环境变量在真实运行中切换到假凭据存储。OS store 不可用仍 fail closed；显式 encrypted-file backend 保留其原有边界。

Adapter 已有 URL-bound credentials 不变。移除 Pi 内建 MCP 的私有登录态导入，不读或删除 native credentials；只依赖该导入的用户重新 OAuth。`auth: { provider }` 继续通过 Pi 的公开 model registry 获取 token，与私有 credential file 无关。

## 公开协作与兼容

命令补全从 parser 共用常量和当前 runtime 集合派生，只列 canonical grammar、合格 OAuth/bearer servers；未知输入 `null`。Prompt completion 沿用上游实现。

已有 `pi-mcp-adapter:tool-approval-request` 保留 **legacy 名称**兼容。普通模式无 claim/`abstain` 回到 grant/config/UI fallback，host-managed 则拒绝；不能因 listener 缺失静默放行。新增跨插件协议一律 versioned；status/runtime/protocol events 和 public exports 之外的私有 state 不构成协作 API。

7.x 的 `mcpScript` 删除、Pi codemode/scriptTools 替代、Pi classifier 登录、extraction opt-in 和 Tasks 合同保留；不带回旧 Jev/System One client/key/endpoint。

## 验证边界

本包保留 completion、cold-loading、mailbox、UI action 四份 Vitest gate，并覆盖新增路径/cache/OAuth/Task 回归、public export 与 stock-host 加载。包内只测本包；真实 CC/Inject/SDK 组合和可选协作方缺失/加载顺序测试属于根 `integration/`。

npm release 缺失的上游 OAuth/conformance fixtures 不代表测试已通过，不能由本地替身 gate 推断其全套覆盖。验证方法见[README](README.md#验证)，本文不保存验收计数、hash、流水或个人目录。

## 上游维护

来源与完整性见 [UPSTREAM.json](UPSTREAM.json)，原版保存在主仓库 `vendor/upstream` 分支的同路径。升级使用根 [贡献规范](../../CONTRIBUTING.md#fork-维护规则) 的脚本与复查流程；原版发布记录留在 vendor，本目录文档只描述当前合同。
