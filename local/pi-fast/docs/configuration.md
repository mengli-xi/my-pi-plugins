# 配置

[返回包入口](../README.md)。

## 来源、优先级与持久化

session override 优先于全局默认。override 以 `pi-fast:session-state-v1` custom entry 写入 session JSONL，数据为 `{ "enabled": true | false | null }`：`true`/`false` 是本 session 的选择，`null` 表示跟随全局默认（`/fast all` 写入的 clear marker）。它只保存扩展状态，不发送给模型。reload、resume、fork 从选中分支重建，session tree 导航或 rewind 到 entry 之前会移除该 override。

全局默认保存在 `<agent-dir>/pi-fast.json`，格式为 `{ "enabled": true }` 或 `{ "enabled": false }`，写入先在同目录建临时文件再 rename，失败时旧文件保持完整。`<agent-dir>` 来自 Pi 公开 `getAgentDir()`，遵守 `PI_CODING_AGENT_DIR`。没有 override 的 session 在每次请求时重新读取；文件缺失、不可读或 JSON 无效时默认为 off。

`/fast all` **仅在写入成功后**为当前分支追加 `{ "enabled": null }` clear marker，防止旧 override 在 reload 后恢复。任一步骤失败都会提示路径和具体错误，不报告保存成功：

- 全局文件写入失败：不清除或改写当前 override，本次请求继续按原 override 生效。
- 全局文件已保存、但 clear marker 写入失败：本次运行仍跟随新默认，并提示 reload 后旧 override 可能恢复。

当前模型不是 `openai-codex` 时，开启状态会提示没有效果，切回该 provider 后才生效。
