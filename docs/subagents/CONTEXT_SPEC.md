# pi-subagents · 有效 Context Fork 契约

目标 Pi 1.5.0 的 `spawn_agent.fork_turns` 接受 `none`、`all` 与 canonical 正整数 `1..100000`，省略为 `none`。选择与 seed 的 owner 是共享 source-only 库 [`pi-session-runtime`](../../local/pi-session-runtime/README.md)。Subagents 负责冻结权限、创建 boundary、session 生命周期与失败映射，不再维护 raw entry rebaser。

## 1. 真实请求 capture

Main 在公开 `context_with_system` 边界记录 candidate：session/generation、leaf、model/effort、active tool/capability 指纹、native provenance 与 run signal。library 用 SessionManager object identity 租用 generation；public provider `streamSimple` wrapper 只复制 normalized messages 与允许的 metadata，原 receiver/options/stream 保持不变。

仅包装 provider 被调用不等于 Main request。capture 还要在 `before_provider_request` / `after_provider_response` 确认同一 session、signal、async invocation、candidate 和 revision；direct summary 或复用相同 transcript 的调用不能消费 Main candidate。provider 不发 native callback、不可装饰或归属不明时 capture unavailable，不解析 provider payload 来冒充证明。

capture 是 Main 最近一次实际发出的 context，不是当前 Magic DB。状态只存内存，`Symbol.for("pi.session-runtime.effective-context.v1")` 使 bundled consumers 共用 owner；引用计数最后 release 清理 observation/capture，Main shutdown/reload retire generation，stale release 不影响 replacement。

## 2. 有效来源与失效

有效 capture 必须仍属于当前 session/generation、active branch，且 selected/physical model（可用时）、effort、tool/capability 指纹一致。capture leaf 后的 compaction/context_edit/branch_summary 等 projection reset 使其失效；只有新增 native tail 才可追加。

Magic 的 public tool/command sourceInfo provenance 或当前 branch 的 `compaction.details.source === "magic-context"` 要求有效 capture。未知 transformer state 同样不能 raw fallback；absence of marker 不证明 native-only。只有当前 capture 已明确证明 native-only 才可用公开 `buildSessionProjection` fallback，其 `exactRequestPrefix` 为 false。结构不匹配的 capture 必须先失效，不能借另一 branch 的证据授权 fallback。

`magic-context:context-epoch` 补丁已撤回，没有订阅。后台 historian/DB 更新不使同一轮 todowrite 后的 spawn 失效；从 Main 最近一次实际请求 fork 不会恢复比 Main 更早的未压缩历史。library 不读 Magic 私有 DB。

## 3. 选择规则

- `none`：无需 capture，不继承 parent history。
- `all`：有效 normalized request，加 capture leaf 后可安全追加的 native tail；绝不复制 append-only file 的所有历史或 abandoned branch。
- `N`：在有效内容内选择最近 N 个可可靠映射的完整 business turn。user、bash/custom input、branch summary 可起 turn；compaction 不计 turn。N 大于可用 turn 时只取有效来源内的全部 turn，不从 raw history 补回被压缩的消息。

numeric mapping 使用精确 provenance。只有明确的 system/compaction/memory preamble 可跨未选 turn 保留；普通 custom/bash text 不是全局 preamble，attached body 跟随所属 turn。未知 request-only custom injection 或含糊 user rewrite 使 N unavailable，all 仍可能可用。

Magic Context 0.41.1 的已知改写可用于身份匹配：只有识别到领先、未加 tag 的 m[0]/m[1] user pair，其有序 block vocabulary、content shape 和相对 body timestamp 均符合 producer 格式时，才识别 text block 上单个 canonical `§N§ ` prefix 和首 text block 上单个 temporal comment。去除这些已知附加项只用于比对，剩余完整消息（含 timestamp、images、metadata）必须按顺序匹配唯一 native origin；不同 timestamp 的重复正文可以区分，完全相同身份或跨 turn/preamble/body 的多候选拒绝 N。pair 作为 memory preamble 连同 system/native summary 原文保留，包括 folded history 与 memory updates；seed 不删标记、不恢复压掉的原文。

MC 会先删除已有 tag notation，再加新 tag，因此存在 MC envelope 时，任何 native user-shaped text block 以 `§` 加数字开头都保守拒绝 N，覆盖 well-formed、malformed、dangling 标签，以及继承 seed 中的已有标签；不区分 turn/preamble/body。没有 MC pair 时 literal 输入仍按 native exact identity 映射。未知 envelope/block、改文/metadata、重复 tag、未知 temporal 格式、origin/envelope 碰撞，以及首次 materialization 尚未被 compaction marker 消除的 dropped-user sentinel 同样拒绝 N。不能用 tag 序号猜身份；native 标签前缀触发有损映射拒绝时，仅保留 system 分类，不发布 turn/body/user-preamble 隐藏 provenance。有效 capture 下 `all` 的消息仍原样保留。

选择截到最大可 replay prefix：不继承 pending assistant 或未闭合 tool batch；duplicate/mismatched/unknown tool result、重复 toolCallId 在整个坏 batch 之前截断。完整 tool-call/result 配对不要求 result 顺序一致。不会为了更新 snapshot 等待或 abort Main。

native fallback 先走 Pi public projection，materialize repeated/self-retaining compaction 与 context edit，再选择稳定 prefix。source branch 的 malformed chain、dangling compaction/edit reference 或失效 capture 会拒绝。`EffectiveContextUnavailableError` 带 `code="effective-context-unavailable"` 与 machine-readable reason，提示为 `effective-context-unavailable: <reason>; use fork_turns=none.`。不静默换 raw 来源，也不无条件建议完成另一轮 Main；新 turn 不能修复未知格式或非单射身份。

## 4. Fresh native seed

`buildNativeChildSnapshot({ selection, cwd, model, boundary })` 接收完整 `EffectiveContextSelection`，输出 fresh native session JSONL 与 `inheritedEntryIds`。ID/parent chain 新分配，assistant thinking/signatures、toolCallId、usage、images 与 nestedCalls 保留。旧 compaction/edit 已投影，不复制会重新暴露 raw body 的 checkpoint/reference structure。

第一个隐藏 custom entry 是 `pi-session-runtime-provenance-v1`：`{version:1, entries: Record<freshEntryId, "turn"|"preamble"|"body"|"unknown">}`。它让 reopen/capture 与再次 numeric fork 恢复继承内容的真实归属，不根据摘要文字猜测；boundary 标为 body。native compaction 可正常丢弃这些消息。

Subagents 随后追加 `pi-subagents-creation-boundary-v1`，说明继承内容只作参考、委派 task 才是当前工作，并追加冻结 model/effort。Goal/Todo/Skills sidecar 等 owner state 不自动继承 authority；权限与 tool/profile policy 仍由 Host 冻结，fork 只改变 context。

## 4.1 SDK 原生压缩与前缀预检

SDK child 使用隔离内存 settings，compaction 固定 enabled；reserveTokens=min(16,384, floor(contextWindow/8))，keepRecentTokens=min(20,000, floor(contextWindow/16))，同时覆盖所选模型的 override。Main 设置不变。普通 settings 保存为 profile.settings_snapshot 的 allowlisted 公开快照，execution 深拷贝并从冻结模型当前 catalog 重算预算；不再有 per-Agent settings cache。resume 只装 idle，零 provider/compact；只有实际 Task grant 后才 preflight。

继承 seed 先用 Pi native estimate + system prompt 文本预算预检；接近阈值时能容纳 summary 输入才先原生压缩，已超过安全 summary 输入窗口则拒绝并要求 fork_turns=none。不是 provider 精确 tokenizer 或跨模型 signed reasoning/cache-hit 保证。Task usage 包含原生 compaction summary 与等待前后各轮。

## 5. 加载与验证边界

轻量 fork grammar inline 到 cold schema/parser；provider capture 的重模块与 selection/seed 在首次有效请求/实际 fork 按需加载。空 Main 会话不创建 service/store/SDK session。Subagents 和 Side 默认且唯一 SDK；Side/BTW 使用 capture/selection/seed，Side 另消费共享 native view，native-record fallback 仍每次打开显式接受。Session Compact 新增 public capture/select consumer，前缀不可靠/完整材料超窗转 small，不新增 privatecapture。source-only 依赖已迁入；正式 profile、真实 provider/cache、人工 TUI 与规模验收尚未完成。旧存储不读、不转换、不删除。

核心验证在 `local/pi-session-runtime` 的 `npm run check`：fork matrix、stable prefix、fresh seed roundtrip、capture ownership/fence/invalidation、nested provenance，以及真实 public Pi SDK/faux provider 的 Main/native-callback negative controls。Subagents 的 typecheck/build/verify-dist 与 context contract tests 验证接线；这些不证明 remote cache hit 或实际 Magic DB 行为。

Magic Context 相关逻辑仅保留已捕获旧格式的兼容解码，当前共享库测试覆盖 legacy tags、temporal/preamble、多段文本/图片及有歧义的历史映射拒绝。没有迁入 Magic Context producer、配置或数据库，不执行其 DB allocation/accounting、完整 pipeline 或 DB-backed renderer；旧的直接发布产物耦合与 merge gate 描述不作为本基线验收依据。共享库升级仍运行 `npm --prefix local/pi-session-runtime run check`，不能据 hash、静态 fixture 或 faux 结果声称覆盖真实 DB/pipeline。
