# 配置

[返回包入口](../README.md)。

配置根目录为 `<agent-dir>/model-prompts/`，其中 `<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

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

## 绑定设置

`/model-prompt settings` 先选命名提示，再选 model ID；只有一个命名提示时跳过首个 picker，按模型名的规则不在此设置页。

- 候选来自 `ctx.modelRegistry.getAll()`、已有绑定和当前 model ID；不读原始 models.json 或凭据，不探测 provider。
- Space 切换，a 全选/取消全选，Enter 保存，d 解除选中行绑定，Esc 取消。UIKit 拥有两层 overlay 的布局、焦点恢复和输入生命周期。
- canonical 内容没变不写；有变更时同目录临时写入、原子 rename，保留原 mode。
- 面板打开后文件版本改变则拒绝保存，要求重开。坏/不可读 bindings 只读；bindings 的软链不替换，提示正文软链不受影响。原子 rename 防半截 JSON，不是跨进程事务或分布式锁。
- 设置仅支持交互 TUI；RPC/headless 说明原因且不写文件。
