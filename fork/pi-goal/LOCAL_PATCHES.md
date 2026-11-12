# 本地维护意图

- Upstream：`https://github.com/narumiruna/pi-extensions.git`。
- 原版与来源信息由 [UPSTREAM.json](UPSTREAM.json) 记录，原版位于主仓库 `vendor/upstream` 分支的同路径。
- 本目录只维护 Goal 一个包；使用与完整合同见 [README](README.md)。升级使用根 [贡献规范](../../CONTRIBUTING.md#fork-维护规则) 中的流程。

## 状态由 Goal owner 派生，不让 presenter 复制记账

`goal:snapshot-v1` 与同步、session-scoped `goal:request:snapshot-v1` 让 CC Style/Compact 等可选消费者获得 live elapsed/tokens，而不解析 goal-state 的 baseline/checkpoint。缺消费者不改 Goal 行为，两种加载顺序都能取快照。

`clockRunning` 是真实 accounting clock authority，不等同 active phase；冻结队列保留 active phase 但停钟。`queueFrozen` 独立表示实际冻结，不等同停钟，普通 paused 不能被显示成 queue off。当前 owner 对存在的 Goal 显式发布 boolean，consumer 只在 `clockRunning === true` 时外推，只在 `queueFrozen === true` 时显示冻结；旧 owner 缺字段不能猜。restore frozen queue 不应重开时钟或收费 offline time。完整字段见 [协议](docs/protocols.md)。

## 阅读和编辑目标不应破坏对话

TUI `/goal status` 使用共享 UIKit status card，不往 conversation 写长状态；保留 viewport/滚动/选择/关闭和 prompt 恢复。RPC 用 observable notification，print/JSON 没输出通道时明确拒绝，不能声称 notify 在这些模式也可见。

无参数 `/goal edit` 与 `/goal modify` 复用菜单的 prefilled editor/edit 路径，避免重输长目标，同时保留 stale editor guard、active-edit confirmation 和无变化/取消不修改。带文本的 `/goal edit` 保留直接更新路径；`modify` 不接受尾随文本，防止 parser 默默丢掉 objective。`idle-checkin` 给长后台等待可控巡检，不等同 Task/process deadline；补全只展示 canonical grammar，兼容 alias 继续读。完整命令见 [命令合同](docs/commands.md)。

## 暂停只收回 Goal 推进权，不取消 producer 的任务

后台 producer 可能在 pause 后交回结果；模型仍需知道 Goal 已暂停，才不会看完结果就继续目标。request-scoped context 在每次 provider request 供应 paused policy，允许读取/验证/记录，不带 active rules、goal_id guard 或 host append，不调用 beginAgentRun、不记 Goal usage、不派新 continuation，terminal tools 拒绝 stopped ownership。

这不是工具沙箱，不加通用只读 allowlist；记录结果可能需要写。Task/process 生命周期和各自 deadline 属于 producer，Goal pause/clear/tree 都不能隐式杀任务或延长期限。25+3、budget wrap-up、stale tools、retry/compaction 的既有安全约束不能因协作而放宽，见 [生命周期](docs/lifecycle.md)。

## Durable mailbox 防止承诺交接后丢掉续跑

自动 continuation、owed background turn、idle check-in、deferred activation 和 budget wrap-up 经 `pi-session-inject/mailbox-v1`；手动 start/resume/edit 保留 user input。Goal 拥有业务 authority/记账/receipt，transport 拥有 durable body、carrier、trigger、恢复 hold 与成功请求证明。缺实现不退私有 native delivery，不从 idle/pending count 或定时器猜丢信。

source intent 在 put 前冻结同一 key、marker、anchor、prompt、policy 与 origin，失败原 key 重试，transport terminal 才清 source bookkeeping。receipt 先持久 owed 再归还，coalesced offers 保留首个 marker/identity；公开 obligation reader 只回答 exact marker 的 owed/none/unknown，不暴露私有 state。

暂停/清除/完成/替换/安全停止/freeze 先过 durable cancel barrier。失败保留 Goal、cancelling hold、owed 和诊断，不宣布成功；pending queue action 到 barrier 成功且 generation/Goal/action 仍匹配才消费。恢复 source intents 由 mailbox hold，`/mailbox resume` 不能恢复 paused Goal。budget wrap-up 新记录用 next-request，其他自动 intent 用 new-run，legacy 缺 policy 仍 new-run。

source session 与 exact origin checkpoint 限制 branch/fork authority，复制 id 或 sibling shared anchor 不能 retarget/cancel。fork 继承 pending 是历史，不获得 source 权限；旧 unscoped intent 仅在公开 root header 证明原 session 时采用，否则 visible-unknown。legacy user carrier 的成功证明与新 custom carrier/transport receipt 分别处理，不能借其他请求的 assistant 成功当证据。完整规则与离线 backup/rollback 边界见 [Mailbox](docs/mailbox.md)。

## Tree 恢复目的 branch，不发起工作

离开前 checkpoint stopped clone，live clock 到导航成功才停，取消导航不漏记；到达后只读目的 branch 的 Goal/queue/safety/pending/owed/mailbox，清旧 ephemeral 和 async authority，不 append Goal state、不发送 prompt。mailbox 用原 frozen origin 继续 reconcile，不造 sibling proof。保留 `{goal}`、plural goals-state、canonical clear 优先及旧 cwd file 的当前兼容，不能复活已清 Goal。

## 保留轻入口与明确构建边界

上游 source entry 改为 `dist/index.js`，减少 Pi 顺序加载的启动开销；Bun splitting 保留 `mailbox-v1/light` 到 engine/store 的首次使用 import，不能重新压成 eager transport。Pi/typebox external，shared transport/registry 的跨副本 process identity 仍由共享库保证。dist 不提交、无 prepare 保证，改 source/source-only dependency 后显式 build + fresh process。

根 workspace/唯一根 bun.lock 统一 development baseline 和共享库解析。Biome 只保留现有 Fork 检查，不引入根 formatter/TS 升级。Goal 的 npm pi-tui-kit 当前锁定 0.40.0。stock Pi 1.5 的公开 API 足够，不新增 host patch/private seam；本包检查仅覆盖 Goal，不能当作整个上游仓库的回归。构建与验证边界见 [维护](docs/maintenance.md)。

边界检查使用根 TypeScript 的稳定 Compiler API，不依赖上游 TypeScript 7 的 unstable API；通过实际解析到的 package metadata 区分外部共享库与扩展，不给特定包名开例外。测试和 typecheck 使用根 loader/toolchain，保留测试源码的类型检查，不留另一套 Fork loader。菜单测试直接驱动锁定版本的真实 custom component；不借用未安装版本的 testing export，也不以更新运行时依赖来修测试。

## Host-owned 附录与 legacy RPC 保留边界

`<getAgentDir()>/goal-append.md` 紧邻 active rules 协调宿主 scope/verification policy，不写死 home，不引入项目配置，也不进入 paused context。文件更新应可见，未变内容不应反复读取/解析，读取故障应可诊断且不泄露正文；这不改变 Goal 完成审计或后台 deadline。

既有 managed RPC 的 pi-goal:start/cancel/event channels 无版本、默认 OFF，仅作为旧兼容保留；不重命名，不伪装成 versioned API，也不另建控制面。开关不是权限沙箱，关闭后已接受 run 仍须有 exact state/cancel 直到 terminal。新协作走版本化 owner 协议，具体 legacy schema 和拒绝行为见 [协议](docs/protocols.md)。
