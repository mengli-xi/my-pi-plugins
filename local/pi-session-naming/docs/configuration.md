# 配置

[返回包入口](../README.md)。

## 来源、读取与兼容

配置由 `conf` 管理，位于 `<agent-dir>/extensions/pi-session-naming/config.json`：

编辑该 JSON 的 `overrides` 可设置 `enabled`（默认开启）、`model`（默认 `session`）、`effort`（默认 `off`）、`maxChars`、`timeoutMs` 和 `maxOutputTokens`。配置在 extension 初始化时读取，手改后需重新加载或新开 Pi process；这不是每轮热更新。手动重命名使用 Pi 内置 `/name`。

`model` 支持 `session` 或完整的 `provider/model-id`，模型 ID 中的后缀按字面保留，不另行解析。指定模型在当前公开 registry 中不存在时，跳过并提示，不回退到当前 provider。环境特定的选择由显式 profile overrides 配置，不写入通用默认值。

配置损坏或 store 不可用时，自动命名禁用并给一次安全诊断，不覆盖原文件；显式恢复后才恢复正常策略。诊断不引用 JSON 原文。

首次加载时，本包会读取一次原 `pi-claude-style` 的 `transcript.sessionNaming` override，并记录 source hash。旧 store 及其 schema backup 仍是只读 migration input。schema v2 会删除已退役的 `showInEditorBorder`：命名开关不再控制 editor chrome。
