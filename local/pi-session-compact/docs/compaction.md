# 压缩与检索合同

## 范围与生成

目标为 stock Pi 1.5 的整会话压缩。只用公开 API，TypeScript 直接加载，无宿主私有接缝。本包须是 profile 唯一的 `session_before_compact` owner，不依赖其他压缩插件。

Main/small 使用 prompt version 9。交接正文采用普通 Markdown，说明当前任务和有效要求、已做工作与关键结论、正在做的事和未解问题、下一步；标题与次序仅作引导。新纠正覆盖旧要求，重要发现、失败方案、运行句柄和不确定事实放在对应事项旁。模型不生成用户原话附录或文件清单。没有输出 schema、引用核验、专用提交工具、记忆候选提取、单独不确定项章节或摘要裁剪。

Main 优先用确认的有效请求 capture，原样保留前缀。明确允许的缺失原因（含刚 resume）可用当前公开 system prompt、active tool 声明和 branch projection 重建同模型请求，再追加相同摘要指令；尊重 compaction/context edit，但不能恢复 request-only 变换，所以不声称精确回放或 cache hit。按整个构造请求估算窗口，不够则转 small；不完整前缀或工具/指纹不匹配仍失败。

运行日志 `outputs.main.prefix` 记录 `source:capture|rebuilt` 和 reason；重建还保留缺失 capture 的 `prefixCapture.reason/generation`（无 lease 为 null）。`/compaction show` 展示来源。resume 后不要求先跑一轮 Main。

只有 `no-capture`、`awaiting-provider-capture`、`native-compaction`、`provider-not-decoratable` 允许重建。结构、身份、branch 失败，包括其他消费者选择时已经记录并清 capture 的原因，均保留失败路径；未知原因拒绝。

Main 保留已证明 system/tools/history 前缀，追加指令、后台材料和 focus。small 使用冻结公开投影，前次摘要恰好一次，包含 custom message、branch summary、context edit；内部 chunk ID/range 不变成模型引用标注。单次、分组/chunk 和 synthesis 准入都估算实际构造的消息。大输入优先按完整 turn/tool group 切块，必要时连续 Unicode 范围切分，不静默漏中段。chunk 写普通临时文字，synthesis 合并，溢出则原生 fallback。

完整非空可见文字可用，即使标题不符或旧 JSON 不能解析。已知旧 JSON/整段 JSON fence 和 `submit_compaction` 参数尽量提取工作文字，去掉旧账本/引用/候选字段。返回工具只记日志，绝不执行；可见文字优先，只有业务工具的回复不可用。空白、不完整 stream、length stop 和 Pi 判断的暂时错误，每个计划请求共用一次额外尝试。成功 chunk 保留，synthesis 自己一次；没有 critic/repair model 或隐藏修复请求。shadow 只尝试一次，原生遵循 Pi retry。用户取消、session/tree 变化不 retry、不 fallback、不提交旧结果。

## 完整用户原话

`compaction.details.userQuotations={version:1,items:[{kind:"user"|"qa",text}]}` 按时间存完整文字，不存来源 ID、不按文本去重。每次只追加实际 final firstKeptEntryId 前新移除的用户输入，包括此前保留尾部现在被切掉的部分；仍保留的输入不入附录。

multipart 按 part 次序拼接；代码、日志、大段粘贴和空白不裁剪。统一用户原话标题下只用 `---` 分隔，不重复 user 标签；QA 保留问答字段。没有 paste 占位符、key_points 或长度上限。非文本附件保留在原会话，不把二进制当用户文字。

Goal 的明确 `<!-- pi-goal-continuation:… -->`、`<!-- pi-goal-prompt:… -->` 标记识别程序 prompt；custom_message 按 entry type 排除，即使公开转换后为 user role。其他 user-role 输入（含未知旧扩展）均可收录，不用自然语言前缀猜来源。

`ask_user_question` 答案须精确 tool-call/question 配对与当前结构化 metadata，保留选项、备注、讨论/解释控制；明确取消的问卷中已有答案注明取消，不当授权。普通工具输出不入附录。显式 QA context edit 用当前投影文字，不用旧答案 metadata。

普通 custom compaction 继承当前 ancestry 的兼容数组；fork/tree 走自己的 branch，不用全局数组。旧/缺数组、原生交错、向后切点和后续 edit 从原分支按公开 edit 语义重建；不复活删除/替换文本，不解析模型写的用户列表。坏 ancestry、缺 retained boundary、坏累积数组取消压缩。原生 fallback 按其实际 cut 重建同一数组，原生自带文件附录不重复追加。

## 文件清单

custom 结果累积 `<read-files>` 和 `<modified-files>`。内置 read/write/edit 路径和 codemode nested call 是观测，不证明执行成功。按会话 cwd 词法规范化去重：目录内用相对、目录外保留绝对，不查文件系统；modified 优先于 read，含继承 alias。cut 前原始调用应用当前 context edit 后重建。

可编辑原调用撤销后，对应旧 cache 路径删除；只有 cache、无法恢复原调用的路径单列 `legacyFileTracking`，不混进已验证清单。不设 200 路径淘汰或摘要百分比配额，旧 omission 数仅作诊断，不编造缺失路径。

路径 parser 保留 Pi 1.5 builtin 的 `~`、`@`、file URL 和 Unicode 空白语义，相对字面 `~`/`@` 前加 `./`；与公开 write operations 边界对照，不 import 私有 helper、不读文件正文。无法解析的历史路径（含失败调用的坏 file URL）保留原拼写到独立 identity namespace，不与解析成功路径合并、不取消压缩；direct/nested/继承统一处理。

## 可选恢复与材料

`pi-session-compact:collect-recovery-v1` 同步请求 `{version:1,sessionId,operationId,restoreSkills,branchEntries,reply}`。任意 owner 可在 emit 栈回复 `{owner,customType,identity,content,order?,covers?}`：owner 自报非空身份，identity 由它解释，order 有限数字升序、同序按 owner 字节序，缺省 100。Compact 提示 order 0，Todo 20，Subagents 40，不设必答名单。covers 默认只覆盖自己的 customType，可声明覆盖的历史类型。

迟到回复忽略；失败、坏回复或无人覆盖的历史标签，只在恢复正文注明未恢复，不取消压缩、不留下阻断状态。只看公开 entry 标签与本协议标记，不解析其他插件私有 data/details。参与方自己验证/渲染规则、待办和运行任务；收集不启动 service/child。

生成前与采用 custom/native 结果后各收集一次；后一次的同一快照用于正文、details 和容量。恢复附录放在交接、原话、文件后，标题 `## 压缩恢复内容`，每项 `### <owner> (<customType>)` 加原文。

持久 `compaction.details.version=2`；`recovery={version:1,items:[{owner,customType,identity,order?,covers?}]}` 只存身份，正文只在 summary。无 order 的旧回复及 version 1 recovery/details 仍可读，不改旧记录；旧 restoreSkills 只用于未恢复提示，不要求旧插件应答、不发修复请求。Todo/Subagents 按自己 owner/customType 的 marker 避免重复；无 marker 保留独立 session_compact 路径。

`pi-session-compact:collect-materials-v1` 请求 `{version:1,sessionId,branchEntries,reply}`，回复 `{owner,skills:[{sourceEntryId,name,path,contents}]}`。owner 选择真实加载版本，Compact 算 contentHash；同路径最后有效贡献胜。缺提供方则 skills 空，不读私有 binding。restoreSkills 只传公开引用，不表示必须恢复。

记忆只消费 `cc-memory:request:materials-v1`，不打开记忆目录。请求 `{version:1,sessionId,context,reply}`，emit 栈回复 payload 或 Promise；payload 为 `{version:1,sessionId,memory:[{path,contents}],known:[{kind,statement}]}`。所有异步回复共用 5 秒等待；超时记 known，已完成回复保留。取消立即清 timer/listener，不生成/提交；迟到或其他 session 忽略，重算 hash，path 仅作来源标识。无人提供正常压缩、材料空；读取规则归 [Memory](../../pi-cc-memory/README.md)。

恢复提示要求遵循最新有效要求、原话只作历史、不重复已做工作、运行任务看 owner 状态和真实通知。收集只改快照载体，不改 producer completion/mailbox 或 Goal 行为。

## 物理容量

检查整个恢复上下文：system/tools、交接、累积原话、合法保留尾部、完整技能、恢复提示、文件、已知 request-only owner 注入和配置的 output reserve，不是摘要配额。

请求层注入按捕获前缀与公开投影差额保守计费，不读私有 binding 证明排除项。原生 fallback 按自己的最终 cut 重算。固定材料放不下在生成前取消；生成正文太大可原生 fallback 一次，并过同一门禁，否则取消并保留历史。不为摘要配额推进 cut。

每个业务请求在公开 context_with_system 再验实际 context。之后增加的内容可阻止请求；已经提交的压缩如实报 committed，不声称回滚。原始 entries 始终可检索。

使用 stock Pi estimateTokens：每图固定估 1200 token，不按 base64 长度，tool result 只计 content 不计 session metadata/details，system/tool 声明同估。经确认的同模型 capture 加首个 assistant response 提供 measured membership proof；只保存实际请求指纹和重数，只有 usage、无 capture 不能限制 raw tail。新输入和 response 另估。edit/compact/model 变化使关联失效；resume 可读版本化操作日志 proof，旧日志退回估算。

提交 proof 与首请求 usage accounting 分开，tree 只选活跃分支精确 compaction，不借别的 session/operation。新/编辑/重复 owner 内容和新 summary/recovery 不纳入旧 bound。估算不等于 tokenizer 真值，base64 transport-byte 门禁独立；后续 hook 再改内容须联测。

重建 Main、small 和原生 fallback 在 custom identity 转普通文字前，都经 mailbox 的只读 filterMailboxMessages：cancelled/receipt-GC/recovery-held carrier 排除，合法 fulfilled/live shared carrier 保留。不跑任意 context hook/producer callback、不改状态或解除 hold；身份/ABI/I/O 不可证时沿压缩失败路径拒绝。信箱启动保持惰性。

## 命令与配置

- `/compact [instructions]` 保留原生 parser。
- `/compaction now [auto|main|small] [focus…]` 只覆盖一次，省略跟配置。
- `/compaction window [tokens|off]` 设置 ancestry-local 有效窗口，不写配置。支持 262k、262144、1m、小数，k=1000；不能超真实窗口，须容纳已知 system/tools、摘要、output reserve、保留尾部和 margin。显示各材料大小。settled usage 严格超过 90% 调公开 compact 一次，失败/仍超阈值仅提示一次，降回阈值或出现新压缩后重置。keep-recent/default 不变。
- `/compaction show` 显示实际投影、交接/原话/文件/尾部/恢复大小、采用模式、原因、重试、耗时和 shadow；技能称公开引用，不猜恢复成功。旧日志缺字段仍可读；TUI 惰性只读面板，RPC 通知，不发模型消息。
- `/compaction reserve [write]` 审计 registry 的 90% 阈值。write 须确认，按 Pi proper-lockfile 锁重读、备份原字节，原子写所选全局模型 token 设置；未知字段/次序和无关并发修改保留，有冲突 compaction/项目配置或重复无效 key 则中止。项目不改，写后重启。

触发诊断记录原生 reason、所选模型窗口、preparation.settings.reserveTokens，推导 `tokens > window-reserve` 及首个整数阈值。session-window 单列，manual/overflow 不标百分比；不是虚拟路由真实窗口证明，也不安装动态策略。缺原生边界明确诊断，90% 比较容许 strict 与 inclusive 的一 token 差，审计/写入仍是显式快照，不自动追踪未来模型/窗口。

参数补全来自 parser 常量/真实 grammar，未知输入 null。CC 的 statusline:row 显示 CP/原生 fallback 和可选 CT，点击同 show；缺 CC 不影响压缩。

配置来源、模型选择、输出与重试兼容、shadow 和时钟预算见 [配置](configuration.md)。

## 原始会话检索

`session_search({query,roles?,branch?:"active"|"all",limit?:1..50,cursor?})` 按 NFC/不分大小写词 AND 匹配，默认活跃 ancestry，最新在前，结果至多 8 KiB。`session_expand({entry_id,part_index?,offset?,limit?})` 精确 ID、Unicode code point 分页，默认 4000、最大 32 KiB 文本，图片仅 metadata 不带 base64。

编辑过的原文标 `contentView:"original"`；不返回 hidden thinking 或检索回声。内存 ID/字节偏移索引跟 append，替换/截断使 cursor 失效，不建数据库或额外 transcript archive。

## 验证

包内 recovery/material 只发公开 DTO，不加载其他插件私有实现；reserve-write 测试用临时配置检查确认、冲突、锁、合并和原字节备份。

```sh
# 仓库根
npm run check -w pi-session-compact
# 包目录；显式指定 stock Pi 1.5
PI_BIN=/path/to/pi npm run check:host
node --experimental-strip-types scripts/replay-saved.mjs /path/to/copied-inputs /path/to/evidence
```

host 仅临时 HOME/profile/session 与 faux、零真实请求；跨插件装配由 [integration](../../../integration/README.md) 管理。PI_COMPACT_HOST_ARTIFACTS 保存证据。离线 replay 只接受显式复制的 runs/sessions，不读日常目录、不 import 网络 runner；按 session header cwd 重建路径，并匹配真实持久 cut、owner appendix/system message 与保存的 request-only accounting。缺失/矛盾报 originalCutWindowUnverified，不当完整恢复通过；输出质量另评。

手动回归检查 main/small/focus、窗口反循环、resume/tree 不重复、旧原文可检索、坏配置/超窗的明确失败和数据保留。faux、合成交接样本不证明真实模型质量、缓存、吞吐或人工终端。
