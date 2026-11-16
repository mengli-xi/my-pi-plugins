# 提示词装配合同

## 来源与排序

`before_agent_start` 收集三类片段，按 key 排序后一次追加到本次系统提示词：

1. `<agent-dir>/model-prompts/<model-id>.md`：按模型名匹配的校准规则。
2. `prompts/<name>.md`：`bindings.json` 选择的命名提示词，可绑定多个模型。
3. 其他扩展通过 `prompt:fragments-v1` 同步贡献的片段，例如 Effort 的 `effort:ultra`。

文件来源 key 中 `model:` 排在 `prompt:` 前；插件 key 也参与同一排序。同 key 后写覆盖，类型与字段见 [contracts.ts](../contracts.ts)。追加不提升指令优先级、不授予工具或执行权限；其他扩展和 provider 仍可变换最终请求。

本包不另发网络请求；所选正文随正常请求发送给当前 provider。提示文件不要放凭据或无关私密资料。只有显式报告才展示当前正文，普通诊断不记正文。

## 文件与匹配

详见 [配置](configuration.md#文件与匹配)。

## 热更新与故障

详见 [配置](configuration.md#热更新与故障)。

## `prompt:fragments-v1`

请求为 `{model,thinkingLevel,selectedTools,contribute(key,text)}`，前三项均可为 undefined。贡献方在 emit 栈内调用 `contribute`，只写自己的 key，空文本忽略，同 key 覆盖，并依据本次确认的模型/工具状态门控。异步迟到贡献不属于该次装配。本包缺席时贡献方不能假定片段已进入模型请求。具体 DTO 和覆盖规则以 [contracts.ts](../contracts.ts) 为准。

## 绑定设置

详见 [配置](configuration.md#绑定设置)。

## 查看与验证

`/model-prompt` 用 UIKit 文本面板展示当前规则、绑定、当前文件正文、规则/软链清单和可绑定提示；RPC/headless 用通知。

当前来源和上次 run 的贡献记录分开：后者只存 model ID、key 和字符数，不存历史正文或最终 provider payload。修改文件只改变当前来源，不改上次记录；session start/shutdown 清记录。检查最终请求须另选明确的 probe。

测试使用临时文件与 Pi/UI 替身。回归应检查文件修改后下次生效、模型/会话切换、绑定保存/清除/取消、并发修改拒写、坏文件保留，以及 Effort 仅 ultra 且确认委派工具时贡献。真实 provider 或人工终端兼容须另验。
