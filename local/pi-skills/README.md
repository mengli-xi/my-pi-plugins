# pi-skills

为 Pi 提供 Codex 风格的显式 skill mention：输入 `$` 选择技能，用精确路径绑定同名项，把完整规则加入请求，并显示独立的 `✦ Loaded skill name` 行。

## 加载与构建

需要 Pi 1.5.0。按[根安装说明](../../README.md#安装与加载)安装依赖，将本包绝对路径加入实际 agent directory 的 `settings.json`，或用 `pi -e /absolute/path/to/local/pi-skills` 临时加载。TypeScript 直接加载，无 build、工具注册或本包配置文件；不自动启用其他插件。

## 使用

```text
Use $example-skill for this task.
/skill:example-skill explain this task
```

- 只有裸 `$name` 是 inline syntax，`$[name]` 是普通文本。`$PATH`、`$HOME`、`$PWD` 等明确 shell variable 不作为技能。
- completion item 绑定准确的 `SKILL.md` 路径。手工输入的 name 只有恰好一个 live 候选时才解析；同名技能必须从补全选择，不猜目录。
- 行首已知 `/skill:name [args]` 是 Pi 原生命令的 input alias，提交时规范成 `$name [args]`。非行首、未知或文件不可读时交还 Pi 原生处理，不新增另一套 slash command。
- 已知 mention 在 editor 和用户消息中显示为等宽 `✦name` chip；`/skill:name` 编辑时显示为等宽 `✦skill:name`。底层 editor、history、session 和模型可见文字仍保留原文本，只有已知命令提交时会规范化。

### 发现与热更新

候选合并 Pi 公开命令 catalog 与按需发现结果。agent directory 由公开 `getAgentDir()` 获取，遵守 `PI_CODING_AGENT_DIR`；用户 Agent Skills 目录遵守进程实际 HOME。项目只有受信时才扫描 `.pi/skills` 与从 cwd 向仓库根查找的 `.agents/skills`。目录规则和 frontmatter 解析使用 Pi 官方 loader。

每次补全检查目录、文件、符号链接和 ignore 文件的 metadata 版本。一个发现根的版本未变就复用其解析结果，不重读正文；变化才重新交给官方 loader。没有后台 watch 或轮询。相同 prefix 再次补全也能发现新增、删除和修改；发现结果优先于同路径的启动 catalog，已删除文件不留作补全候选。普通请求/context 阶段不扫描技能目录。

### 注入与数据边界

提交时读取所选技能完整文件，通过 Pi `context` event 在对应 user message 后插入 request-only message：

```xml
<skill>
<name>example-skill</name>
<path>/absolute/path/to/SKILL.md</path>
...完整 SKILL.md 正文...
</skill>
```

可见用户消息与规则在同一次 provider request 中成为相邻的 user-role items。规则不会作为新的 LLM message 写入 session tree；一个 non-context sidecar 保存精确 name、path 和完整正文，resume 可重建同一版本，后来编辑磁盘文件不改写已保存版本。rewind 到该 user message 之前，active branch 不再有对应注入来源。旧 truncated sidecar 会尝试刷新，无法取得完整正文时提示；不把残缺版本显示成完整 Loaded 行。

规则正文会随普通请求进入所选 provider；启用 Compact 协作时也会进入其选择的压缩模型，并保存在当前会话 sidecar 和压缩恢复正文中。本包不是权限沙箱。它不复制个人技能、配置或其他插件的私有存储，也不自动执行技能附带脚本。

## Loaded 行与可选 UI 协作

每项显式技能都有独立且不折叠的 `✦ Loaded skill name` 行，不进入 assistant/tool folding，也不额外注入模型。

agent 通过内置 `read` 完整读取当前可调用 catalog 中的 `SKILL.md` 时，也会生成 `pi-skills:agent-read-v1`。tracker 按 canonical path 累积成功读取的行区间；一次读完或分段完整覆盖后才算 loaded。普通同名文件、失败、缺口或未完成的读取不算。确认时保存完整文件快照，只作审计与展示，不再次注入技能。

Pi 1.5 codemode nested read 通过公开 `parentToolCallId` 与父结果 `nestedCalls.calls` 关联，在父结果已持久化的 `turn_end` 追加行。`complete=false` 时只认可有界记录中仍有证据的成功 read；遗漏、错误、未结束或父 ID 不匹配的记录不跨回合保留。

### 消息装饰协议

`Symbol.for("ui-pack.user-message-render-transforms.v1")` 存放 `{version:1,transforms:Map<symbol,(lines:string[])=>string[]>,hostOwner?:symbol}`。Skills 注册自己的等宽 transform；CC Style 的 compact-message host 存在时由它应用，Skills 不抢 prototype ownership。没有 host 时 Skills 提供 native-renderer fallback。未知 registry、transform 异常或不可用的私有 render seam 退回原生消息呈现，不影响技能加载。

editor decorator 返回原 editor instance，只包装 `render()`，保留 autocomplete、children 和其他 UI adapter 可发现的 state。`UserMessageComponent.prototype.render` 的 fallback 替换属于私有 seam；安装点与 `scripts/probe.ts` 检查可写 data method，升级漂移时不安装该装饰。

Loaded 行通过 `pi.claude-style.custom-entry-presentations.v1` 委托 CC Style 配色和只读 Markdown overlay，`handleMouse` 转给 provider 组件，由 CC fullscreen 派发真实鼠标事件。provider 晚加载、卸载或失败时恢复本包 accent 单行；没有 CC 时只失去其点击面板，不影响行和技能语义。旧 `truncated:true` sidecar 不渲染，避免把残缺内容显示成完整技能。

## 压缩材料与恢复协议

本包独占自身加载记录的解析，不要求 Compact 读取 Skills 私有格式或登记插件白名单。协议索引见[根能力表](../../README.md#能力协议表)。

### 同步材料与嵌入恢复

响应 `pi-session-compact:collect-materials-v1`：请求须为 `version:1`、匹配当前 session 的 `sessionId` 并带同步 `reply`。从当前分支自有完整持久快照回复：

```ts
{ owner: "pi-skills", skills: [{ sourceEntryId, name, path, contentHash, contents }] }
```

支持 `pi-skills:binding-v1`、旧 `pi-skill-mentions:binding-v1` 与 `pi-skills:agent-read-v1`。同路径选择分支中最后一个有效完整版本，排除 truncated；read 还校验 `source:"agent-read"`、`toolCallId` 和 skill。正文来自已加载快照，不从当前磁盘或模型摘要推造历史。

响应 `pi-session-compact:collect-recovery-v1`：校验 session/version/operation，同步回复 `{owner,customType,order,covers,identity,content}`。owner 为 `pi-skills`，customType 为 `pi-skills:compact-restored-v1`，order 为 10；covers 列出上述三种已恢复源标签。引用按 source entry、name、path 和正文 SHA-256 证明；只解析自己公开标签对应的数据，不认领其他 owner 的引用。空引用时可从当前分支自有完整版本提供规则，重复引用与同路径版本去重。

正文通过 `renderSkillInstructions` 随 summary 提交。公开 `details.recovery` 中含本 owner/customType 时，不再追加单独恢复消息；连续压缩仍用原 binding/read 证明版本，而不是只凭 marker 宣称恢复。可选材料收集失败只回复未恢复错误，不 abort、不留下请求 latch；缺 Compact 时显式技能、read tracker 和原生压缩照常工作。

### 旧独立恢复通道

保留 `pi-skills:compact-restore-request-v1` / `pi-skills:compact-restore-response-v1`。请求 `{version:1,sessionId,operationId,skills:[{sourceEntryId,name,path,contentHash}]}` 只对应当前分支相同 operation 的 compaction；回复 `persisted|pending|failed`。

无嵌入 marker 的旧记录仍幂等持久写入 `pi-skills:compact-restored-v1`，不启动新业务 turn。`nextTurn` 补发在下个 context 核对 presence；只有这条旧通道中已经要求恢复、却无法证明已持久化的规则才警告并阻止依赖请求，避免空规则继续执行。它不是缺少可选协作方时的阻断条件。session/tree 切换清 pending，quit/reload 注销 listener。

## 验证与日常回归

在仓库根运行：

```sh
npm run typecheck -w pi-skills
npm test -w pi-skills
npm run check-internals -w pi-skills -- /absolute/path/to/pi-1.5.0
npm run test:integration
```

host probe 使用独立 HOME、agent 和 session directory，只验证 user-message render seam，不代表完整 TUI 验收。跨插件联测与隔离要求见 [integration](../../integration/README.md)。

日常可核对：同名技能从补全选中正确路径；同 prefix 发现新增/改名/删除；`$HOME` 不变；完整/分段/nested read 仅显示一次 Loaded 行；resume 和 rewind 保留准确来源；压缩两次仍保留完整规则且无重复恢复；无 CC/Compact 也能正常请求；窄屏、输入法、鼠标和取消不改提交原文。
