# 维护与测试

## 构建与目录

Pi 从 `dist/index.js` 加载插件，从 `skills/subagents` 加载技能。`scripts/build.mjs` 先清理 dist，再用 tsc 逐文件输出 Main/SDK；Bun 仅内联共享 fork grammar，`typebox` 保持外部依赖。生成物不提交。

| 目录 | 职责 |
| --- | --- |
| `src/config` | schema 2、配置来源、严格 JSON 与错误诊断 |
| `src/domain` | ID、路径、Task 状态、超时和结构深度 |
| `src/tools` | 工具 schema、解析、注册、结果、错误和本地查询 |
| `src/roles`、`src/capabilities` | 角色范围、能力闭包、工具和工厂指纹 |
| `src/context` | 有效请求选择、冻结 profile 与原生 seed |
| `src/host` | 可信 caller、串行事务、Main 生命周期、投递与 receipt |
| `src/persistence` | 锁、journal、checkpoint、prepare、恢复和删除 |
| `src/scheduler` | open/active 准入、FIFO、公平轮转和等待激活 |
| `src/runtime`、`src/child` | SDK 装配、Task grant、输入、中止、应用证明与 ACK |
| `src/ui` | 分类、列表、strip、statusline、原生视图与已读回执 |
| `test/unit`、`test/contract` | 本包离线测试 |
| `test/real` | 仅加载本包和 faux provider 的宿主测试 |

共享库通过根 workspace 解析，没有各自的安装步骤。修改共享库或编译源码后，重建直接消费者，再启动新 Pi 进程；`/reload` 只验证生命周期，不代替构建。统一 transport build 为 `mailbox-v1.0.6`，不能混用旧 bundle。

## 排障

| 现象 | 处理 |
| --- | --- |
| `agent-closed` | 先 `resume_agent`、列表 R 或 child `/resume-agent`，再单独发送输入 |
| `agent-closing` / `cleanup_pending` | 等工具、prompt、公开 idle 和控制 ACK 排空；仍占容量，不能硬杀同进程 JS |
| `open-agent-capacity` | 收集结果后关闭闲置子树；closed 不占 open，closing 仍占 |
| `agent-busy` | 停止中的 Task 不收普通输入；新工作用 interrupt 或 UI Alt+Enter 排队 |
| activation queued | 原 Task/依赖/lease/deadline 保持；不要重复发送或把正常等待误判为失效 |
| frozen unavailable | 核对工厂、文件摘要、model scope、凭据和 prompt artifact；不能扩权或换模型执行 |
| host capability 拒绝视图 | 检查 [主题合同](ui.md#5-主题与终端释放)；双面缺失可原版降级，单面或未知值拒绝 |
| config-invalid | 按中文来源/key 诊断删除旧 backend/resident/liveView 键；Main、close、历史和既有投递仍可用 |
| unread 未清 | 成功进入视图只清自产标记；收到的后代卡片须点精确卡片；失败初始化/写入不标读 |

`delivery-failed` 当前没有公开 retry 端口，不能承诺 `/subagents` 会重试全部故障。未知 commit 先查 receipt 和 journal，不重发业务模型请求。

## 数据兼容、备份与回退

数据位于 `<agent-dir>/pi-subagents/store-v2/mains/<mainKey>`，诊断位于 `<agent-dir>/pi-subagents/diagnostics/`。不读取、转换或删除 store-v1。journal 格式升级与故障恢复见 [持久化合同](persistence.md)。

- 备份前停止该 store 的 writer，保留整个 Main store 和对应原生会话；journal、checkpoint、CURRENT 和冻结 prompt 必须配套。不要只拷某个实体 JSON。
- 不手改 journal、CURRENT、receipt 或摘要以强行兼容。无法证明的数据保留原字节，按 unavailable 处理。
- 回退先停新 writer，再恢复兼容的整套代码、配置和备份；不能让新旧代码交叉写一个 store。没有降级转换器。
- 冷恢复将 ownerless 未完成 Task 结算为 interrupted/host-lost，关闭 Agent，取消旧输入；既有 Completion 和投递继续对账，不从 assistant tail 猜成功，不自动重跑模型。
- prepared 事务缺 `prepare.json` 且只剩安全空目录时，按 aborted 清理并记录 `incomplete-prepare-aborted`；有文件、链接或不安全目录时保留并拒绝打开。

## 验证入口

仓库根运行：

```sh
npm run typecheck -w pi-subagents
npm run build -w pi-subagents
npm run verify-dist -w pi-subagents
npm test -w pi-subagents
PI_BIN=/path/to/pi-1.5.0 npm run test:real -w pi-subagents
```

跨插件、缺失协作方和宿主矩阵统一见 [integration](../../../integration/README.md)。包内测试不加载其他插件，不读日常配置，不发真实 provider 请求。改 slash 参数时同时检查空、部分、未知输入的补全与实际 parser。

## 核心回归

- spawn：none/all/N、depth 1/2、role/tools fences、canonical builtin factory、Pi.VERSION/proof 和实际 execution factory 漂移；缺 proof 只能读历史。
- close/resume：idle、busy/force、整树 drain、closed 输入拒绝、resume 零请求后另发输入；Main quit/new/switch/reload 后全树关闭。
- wait：caller-owned 准入快照、释放 active、中间 card 和最终聚合 Wake；之后的新 Task 不混入旧 barrier。
- Process 排队：active 满位超过 30 秒仍可激活；取消、关闭、超时撤销同 Task/generation 的待激活工作，晚到 grant 不发请求。
- 输入：Enter 同 Task，Alt+Enter 新 FIFO；匹配 generation 的 starting 装配可准入，历史 unavailable execution 拒绝；durable 成功才清草稿。
- 删除：已完成 open 子树先 close/drain，再重验 revision、投递退休、lease/ACK/prepare；未完成工作不隐式 force，取消事件视为 terminal。
- 持久化：单 writer、prepare/commit 补偿、CRC/截尾、checkpoint 读回、配额与 ENOSPC；冷恢复不重放 provider。
- 投递：精确 card/hash、Barrier 基数、late claim、防双 owner、pending receipt 后链接、Main accepted/handled 与 ACK/GC；错误窗口只允许合同规定的逻辑重复。
- UI：Running/Done 同源分类、稳定 ID、窄屏/滚动/过滤后的鼠标命中；成功 onLoaded 清自产标记，坏回执不标读。
- 前台：单 stdin，Main editor/draft/keybindings 保留；初始化超时可返回，迟到输出不污染新视图，quit 不重启 Main。

faux/PTY 不证明真实 provider 的质量、缓存、人工 IME/终端或规模性能。需要这些结论时另做对应验证，记录实际环境和边界，不复用旧宿主数字。
