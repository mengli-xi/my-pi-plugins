# pi-subagents · 能力与冻结执行配置

## 1. Authority 与显式 factory

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0、唯一 SDK。capabilities/{closure,registry,fingerprint}.ts 和 runtime/factory-catalog.ts 定义准入。pi-runtime-contracts 拥有 versioned registry；Main package 注册 owner/target descriptor，Subagents 冻结 target=pi-subagents 的 closure，Side 直接解析 target=pi-side-chat。SDK factory 自身不注册 capability、不做 OS attestation；这层 SDK factory/provider 准入仍无 marker/nonce/ready handshake 前置。managed native thread UI 另有 [UI_SPEC §5](./UI_SPEC.md#5-主题与终端释放) 的 UI host-capability 检查；它只约束 handoff，不改变 provider grant、tool/model scope 或上述 attestation 边界。

registry conflict、target/package/export/hash 不匹配拒绝，不能扫描 Main extension paths 或复制未知 pure hooks。外部 provider 只通过已声明、独立批准的 `sdk_provider_factory` 装配，沿用实际 assembly 的 canonical 公开 Pi namespaces；loader 只 cache 模块/identity，不 cache instance/options。同路径代码或明确 delegates 变更要求 fresh process，不拿新磁盘 hash 给旧 Jiti cache 背书。

`pi-session-runtime/sdk-provider` 共用于查询、spawn 准入和执行。target 的纯数据声明定位实际 package.json、child、factory module/export/config/artifacts 与可选 observer；实际 agentDir 的 `sdk-provider-grants.json` 独立批准完整 owner/Main/target 身份。注册不授权，grant 与声明相同仍必须核验当前磁盘文件；查询不 import 工厂。provider ID 不再是品牌枚举，只有获批工厂可用，缺失或漂移拒绝、不悄换 provider。Core 固定传 `{version,target,agentDir,providerId,modelIds,config}`，config 不能覆盖核心参数。可选 observer 也须批准，只有声明 input 与已校验的 provider activity output；detach 不释放 execution，失败/dispose 释放。公开 provider 引用只作 cooperative replacement fence，不是 host-attested 来源证明或 OS sandbox。完整协议见 [sdk-providers.md](../../local/pi-subagents/docs/sdk-providers.md)。

## 2. Tool closure

Main active tools、registered definitions 与 role allowlist 共同决定 child 工具。普通 read/bash/edit/find/grep/ls/write 保持同 public API。本轮 builtin extension consumer 仅 codemode/tool-search 的 canonical factory，前端 `builtin:<owner>` 准入与后端受控装配一致，仍受 role/tools fences；未知 owner、定义漂移或不支持的公开合同拒绝，不以 ambient discovery 补齐。共享 Runtime 的通用显式 Builtin 接口默认全禁，其可选 MCP 能力不等于本 consumer 支持。未选中的 builtin 不启用，llama.cpp 不是工具，本轮不启服务。role tools=*只选可证明 owner 的当前 active 工具，未知 SDK/未声明工具跳过并 diagnostic；显式列出不 active/undeclared 工具拒绝，不扩权。

当前 MCP owner 是 pi-mcp-adapter，不是 stock MCP。child 继承须由 adapter 自己明确能力声明/工厂，并经后续独立迁移验收，现在不宣称支持；不使用 native MCP 替代、不解析 stock MCP 配置或冻结 raw 凭据，也不增加配置 pinning。

mandatory collaboration tools 包含 send_input/wait/list/model/role 查询及允许 depth 的 spawn，child finish_task。close/resume 永远 Main-only；达到 ceiling 从 registered definitions、active tools、profile、fingerprint 与 prompt 同时去 spawn，Host 复核 persistent 结构 depth 和 min(frozen ceiling,current maxDepth)。默认 maxDepth 1，可配置 2，孙 Agent 始终不能再 spawn。

fingerprint 包含 canonical tool schema/description/promptGuidelines 及 owner、target hash 和完整 allowed tool 顺序/definition digest；dynamic ambient 插件新增不自动进入旧 Agent。未知/冲突 definition 不能靠同名工具替换。factory catalog 保留 Processes child、native-search、pi-bash-timeout、CC presentation 与经独立 grant 批准的外部 provider；非 builtin Search/Processes 的 `execution_factory` proof 必须覆盖实际 import 的物理 factory 文件及 export，直接读该文件做 SHA 校验，不能只校验转发 wrapper 后执行未校验文件；旧 frozen Pinned presentation 仅忽略、不加载，其它 Main 插件不复制。

`pi-bash-timeout` 是 source-only required-only tool owner，Main 的同名 `bash` override 归该 package；catalog 只接受匹配 owner/package、`extensions/child.ts`、target hash 和 `createBashTimeoutChildFactory` export。Main/child 共用同一个 definition factory，description/schema/promptGuidelines 指纹不匹配拒绝，不退回内置 bash；包未加载时 bash 仍归 builtin。本包只改 timeout 必填契约，child factory 不注册 capability 或读 ambient identity，执行仍用 child 的公开冻结 settings 和 Pi bash 实现。

## 3. FrozenProfileV1

profile.version 仍 1，store namespace 是 v2。持久字段包括 role{name,source,provenance,body,sha256}、provider/model/model_scope/reasoning_effort/service_tier?、task_timeout_ms/cwd/project_trusted、allowlisted 公开 settings_snapshot、delegation_max_depth、capabilities{version,fingerprint,active_tools,tool_definitions,entries}、prompt options/hash/assembler version/system-prompt path/bytes/hash 和 created_at。

builtin entry 使用 `builtin_proof={version,pi_version}`，核对 assembly 的 canonical Pi.VERSION；不对 builtin 标识做物理文件 SHA 读取。非 builtin Search/Processes 使用实际 `execution_factory` proof；旧 profile 仍可读历史，缺少对应 proof 不执行，不从当前环境自动补齐。

role 优先 trusted project > user > builtin，model/effort/tier 解析与范围见 TOOL_CONTRACT；child scope 只能是父 scope 子集，nested artifact/profile 重新复核 cwd/trust/model/tool/entry owner subset。model scope 冻结为授权 canonical IDs，credentials 通过 public ModelRuntime/Auth，不持久 secret。provider proof 包含完整批准 manifest 与确切 model_scope，并进入 fingerprint；nested 只能缩窄，旧无 proof 的外部 provider profile 只读历史，不自动补授权执行。

Pi 1.5 公开 before_agent_start.systemPromptOptions/builder，创建先解析公开 options 与 role instruction 再冻结 rendered prompt 和 system-prompt.txt，不在 resume 重跑 mutable Main hook；role/package/auth drift 不能静默扩权限。role 有变化不改已创建 Agent，必要时 spawn 新 identity。

## 4. SDK assembly、resume 与压缩

execution 使用 public services/session runtime，独立 SettingsManager.inMemory/ModelRuntime/resource loader/SessionManager，no ambient extensions/skills/context/templates/themes，只显式 execution factory。profile.settings_snapshot 深拷贝，每次按冻结 model 当前 window 重算 native compaction；不缓存新 Main mutable settings 作为旧 Agent authority。Main 默认配置与 env 不被改写。

resume 核对 frozen artifact/hash/model/credential/factory，只恢复目标 idle，零 Task/lease/provider/compact。超窗 preflight 必须在真实 Task grant 后，无法安全 summarize 拒绝并推荐 none；用户打开 closed history 可以用 provider-only/presentation 和 tools=[]的 in-memory runtime，不允许 fallback model 执行旧 Agent。

CC execution assembly 安装轻 recorder，Detached 仍写真实 run metrics；UI 每 view attach/detach。CC 只接受 `dist/child.js` 与空 tools/providers/commands 的纯 presentation descriptor，不注册 builtin execution；标准 Main profile 显式选择七个内置工具。现有 CC presentation 是 native child view 的必需依赖；本轮不迁入、不提交 Processes/CC，仅在目标外使用真实源码构建产物作为所需测试依赖，不算它们验收。缺席时如实拒绝该视图，不删功能或将 fallback 当完整验收。Main completion append 只用公开 branch API 与 mailbox，没有旧三项 private seam；Side 两 visibility probe 属于 Side，不当 SDK 能力 attestation。

assembly、approved factories、managed view 共用 `getSessionAssemblyPublicModules()` 的进程级 immutable Pi coding-agent/ai/tui 表；同版本不同 physical copy 不能当作同一 class identity。同一 factory 路径切 realm 在 import/cache 前拒绝，readonly history 也用 canonical SDK 创建。TerminalOwner 在 acquire 首次使用时保存并恢复 canonical TUI 的原始 keybindings 引用，await 后重验取消与 lease。协议与双 loader 回归见 [session-runtime](../../local/pi-session-runtime/README.md)。

## 5. Persistence 与验证

profile/工具/factory snapshot 是 admission proof，prepare/native artifact/hash 与 Task owner/lease proof 在 Host 事务验证；closed 不清持久权限。generation 是 Host runtime fence，不是 OS PID。正常 SDK agent_settled 才读 native result/usage；cold owner loss 不能从 tail 证明成功。

验证包括 codemode/tool-search canonical factory 前后端一致装配、role/tools fences、Pi.VERSION 与 builtin_proof 匹配、其他 builtin 默认禁用且 llama.cpp 不启服务、adapter MCP 无声明时不继承、非 builtin Search/Processes 实际 execution_factory 文件漂移在 import 前拒绝、closure/wildcard 与 explicit unknown、source canonical identity、schema hash/conflict、scope 缩窄、maxDepth 1/2 完整去 spawn、model/effort/tier/credential drift、resume 零请求、native compaction、真实 CC/Processes/Search/Timeout 装配与中性外部 provider factory；缺 grant、实际执行文件/observer/delegate drift、target 混用、await 撤销和 code-cache fence 必须在 import/request 前拒绝。public Pi API 由 typecheck/行为 test，CC 的独立 private catalog 与 Side 两项 probe 使用 stock Pi 1.5；faux 不证明真实 cache/provider 质量，见 TEST_PLAN。
