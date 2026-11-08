# pi-subagents · Package 布局

## 1. 唯一 SDK 入口与加载

package.json 的 Pi extension 仅 dist/index.js，skill 目录 skills/subagents。Main/SDK 全部 tsc 按文件编译，scripts/build.mjs 先清 dist 再输出；Bun 仅将共享 fork grammar inline 到 dist/tools/schemas.js、validate.js，typebox external。没有 dist/child.js、supervisor.js、旧 OS child/channel/RuntimeController/terminal-handoff 产物。生成 dist 不提交。package 交付源码、技能和回归测试，仓库根目录 docs/subagents 下的 16 份现行规范另计；不提交生成的 dist，也不沿用历史 build/验收结论。历史 IMPLEMENTATION*/IMPLEMENTABILITY 报告和 ADR 随原仓归档，未迁入，也不作新验收证据。

src/index.ts 是 cold entry，工具 definitions/schema/validation、轻量 status/view 路由先加载；首次 context/工作才 import service/store/manager/SDK assembly。verify-dist 检查 cold 图/禁止机器绝对路径和旧 entry；不要用 rootbarrel 重新引入 eagerassembly。xterm 仅 devDependency 用于真实 MainPTYtest，不是 runtime backend。

## 2. 目录职责

| 目录/关键模块 | 单一职责 |
|---|---|
| config/{types,schema,load} | schema 2、来源/strictJSON、删除 key 诊断、新 capacity/depth/default |
| domain | opaqueIDs/path、Task 状态/timeout、persistent 结构 depth |
| tools/{schemas,validate,register,results,errors,local-query} | public 八工具 grammar、注册、envelope/错误、model/rolequery |
| roles/capabilities | rolebody/scope、descriptorclosure、tool/factory/promptfingerprint |
| context | public effectivecapture/select、frozencontext/profile/nativeartifact 准备 |
| host/core、types | 可信 caller、serialmutation、prepare/commit/owner/lifecycle/input/receipt |
| host/process-service、service-cell | process 内 Mainscope 绑定、lazy SDK 连接、Main ending 全树关闭；不是 OSprocessbackend |
| host/delivery-engine、main-append-port、producer-proof | frozenInbox/Outbox/card/native proof、Wake/Goalreceipt、safeMainappend |
| persistence | store-v2、lock/canonical/journal/checkpoint、prepare/receipt/recovery/cancel/unread/delete |
| scheduler | open/active 准入、MainFIFO/公平轮转、waitingactivation；无 LRU |
| runtime/child-session、sdk-controller | public SDK assembly、generation、Task grant/abort/drain、directviewinput 和 draft |
| runtime/child-tools、factory-catalog | child 本地 Host/Processbridge 与 approved namedexecution/presentationfactory |
| child/{tool-port,tools,lifecycle,conversation,events,mailbox-injection,process-wait-*} | 同进程小型领域端口、finish/lease/nativeappend/application/ACK，不是可执行 childentry |
| ui/{agent-presentation,manager,strip,statusline,sdk-child-view,completion-renderer} | 纯 classifier、Running/Done、确认动作、managednativeview 与精确已读 receipt |
| test/{unit,contract,fixtures,real} | 核心领域/集成/nativeTTY/faux 验证，helper/probe 不进生产 cold 入口 |

删除 OS 传输后复用的小型类型在 child/tool-port、conversation 和 SDK controller；canonical encoder 在 persistence/canonical，不保留 supervisorhelper。领域 kind=followup、DTO runtime=resident 等内部名称不代表旧 public 工具或 resident 预算。

## 3. 依赖与 factory

file: pi-li-uikit、pi-runtime-contracts、pi-session-runtime、pi-session-inject；目标 Pi 1.5.0 公开 peer/dev 包与 typebox。source-only shared libraries 已迁入，无 extension registration/独立 build，修改后重建直接 compiled consumer Subagents；mailbox-v1.0.5 要求相关 consumer 同步新 build/fresh process。approved Processes/Search 与受控外部 provider factory 登记 direct-source/provider contract；provider 纯身份判断由查询/准入/catalog 共用。本轮 builtin consumer 仅 codemode/tool-search canonical factory，遵守 role/tools fences，以 `builtin_proof={version,pi_version}` 核对 canonical Pi.VERSION；共享 Runtime 显式 Builtin 接口默认全禁，未选中的 builtin 不启用，llama.cpp 非工具、不启服务。当前 pi-mcp-adapter child 继承须有 adapter 自己的能力声明/工厂并独立验收，现不宣称支持，不以 stock MCP 替代。非 builtin Search/Processes 的 `execution_factory` proof 才直接读取实际物理 factory 文件做 SHA 校验，不靠 wrapper hash 代替；旧 profile 可读，缺 proof 不执行。CC descriptor 和 explicit factory 保留 owner identity，旧 Pinned entry 忽略、不加载；现有 CC presentation 是 child view 必需依赖；本轮不迁入、不提交 Processes/CC，只在目标外使用真实源码构建产物作所需测试依赖，不算它们验收，不删功能假造通过。其它 package 的 OS wrapper 不能当 Subagents loader 入口。

## 4. 开发命令

```sh
npm run typecheck
npm run build
npm run verify-dist
npm test
# Managed native UI host requirements: UI_SPEC §5.
npm run test:real-sdk-view -- /path/to/patched-pi-1.5.0
```

test 使用 strip-onlyTS，避免 constructorparameterproperties；followpackage 脚本的 tsresolver。real-*名称可能沿用 process-child/followup，但实际 fixture 以 SDK 同 session/generation/closed 语义为准，不能据名称推 OSbackend。fresh process 加载，不用/reload 代替 build/restart；full-settings 仅隔离副本，productionprofile/日常 auth/store 不改。旧三项 Main append private probe 已退役，适用 consumer 的 probe 另验。共享 gate 详 TEST_PLAN；本轮文档修订不运行 build/测试/安装。
