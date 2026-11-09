# 提示词装配合同

## 来源与排序

`before_agent_start` 收集三类片段，按 key 排序后一次追加到本次系统提示词：

1. `<agent-dir>/model-prompts/<model-id>.md`：按模型名匹配的校准规则。
2. `prompts/<name>.md`：`bindings.json` 选择的命名提示词，可绑定多个模型。
3. 其他扩展通过 `prompt:fragments-v1` 同步贡献的片段，例如 Effort 的 `effort:ultra`。

文件来源 key 中 `model:` 排在 `prompt:` 前；插件 key 也参与同一排序。同 key 后写覆盖，类型与字段见 [contracts.ts](../contracts.ts)。追加不提升指令优先级、不授予工具或执行权限；其他扩展和 provider 仍可变换最终请求。

本包不另发网络请求；所选正文随正常请求发送给当前 provider。提示文件不要放凭据或无关私密资料。只有显式报告才展示当前正文，普通诊断不记正文。

## 文件与匹配

```text
<agent-dir>/model-prompts/
  model-a.md
  prompts/zh-writing.md
  bindings.json
```

```json
{ "zh-writing": ["model-a", "model-b"] }
```

绑定 key 是提示词名，不是 provider ID。两个 provider 的同名 model ID 共用绑定与规则。model ID 的 `/`、`\` 转为 `_`；可能发生规范化重名，这一匹配兼容性保持不变。提示名不能含路径分隔符或以点开头。`constructor`、`__proto__` 等 key 不继承对象原型属性。

支持已有提示文件软链。这是操作者信任的配置，不是文件系统沙箱。安装不复制用户提示、bindings、模型配置或凭据。agent-dir 取公开 `getAgentDir()`。

## 热更新与故障

每个 run 按 dev/inode/size/mtime/ctime 检查版本，未变的正文和 bindings（含失败）复用缓存。编辑、替换、新建、删除在下个 run 生效，不重写文件、不必重启；run 不等于每个 token 或 tool call。本功能不改变 Pi 的 AGENTS.md 原生重载行为。

缺失/空提示不贡献，缺 bindings 表示无绑定。读失败或坏 JSON 按失败版本只报一次安全诊断，不含正文或 JSON 解析原文片段。部分无效 bindings 中的合法条目仍可读，但修复前设置页不能覆盖该文件。

## `prompt:fragments-v1`

请求为 `{model,thinkingLevel,selectedTools,contribute(key,text)}`，前三项均可为 undefined。贡献方在 emit 栈内调用 `contribute`，只写自己的 key，空文本忽略，同 key 覆盖，并依据本次确认的模型/工具状态门控。异步迟到贡献不属于该次装配。本包缺席时贡献方不能假定片段已进入模型请求。具体 DTO 和覆盖规则以 [contracts.ts](../contracts.ts) 为准。

## 绑定设置

`/model-prompt settings` 先选命名提示，再选 model ID；只有一个命名提示时跳过首个 picker，按模型名的规则不在此设置页。

- 候选来自 `ctx.modelRegistry.getAll()`、已有绑定和当前 model ID；不读原始 models.json 或凭据，不探测 provider。
- Space 切换，a 全选/取消全选，Enter 保存，d 解除选中行绑定，Esc 取消。UIKit 拥有两层 overlay 的布局、焦点恢复和输入生命周期。
- canonical 内容没变不写；有变更时同目录临时写入、原子 rename，保留原 mode。
- 面板打开后文件版本改变则拒绝保存，要求重开。坏/不可读 bindings 只读；bindings 的软链不替换，提示正文软链不受影响。原子 rename 防半截 JSON，不是跨进程事务或分布式锁。
- 设置仅支持交互 TUI；RPC/headless 说明原因且不写文件。

## 查看与验证

`/model-prompt` 用 UIKit 文本面板展示当前规则、绑定、当前文件正文、规则/软链清单和可绑定提示；RPC/headless 用通知。

当前来源和上次 run 的贡献记录分开：后者只存 model ID、key 和字符数，不存历史正文或最终 provider payload。修改文件只改变当前来源，不改上次记录；session start/shutdown 清记录。检查最终请求须另选明确的 probe。

测试使用临时文件与 Pi/UI 替身。回归应检查文件修改后下次生效、模型/会话切换、绑定保存/清除/取消、并发修改拒写、坏文件保留，以及 Effort 仅 ultra 且确认委派工具时贡献。真实 provider 或人工终端兼容须另验。
