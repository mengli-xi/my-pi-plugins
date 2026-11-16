# 配置

[返回包入口](../README.md)。

## 文件与示例

从实际 `getAgentDir()`（遵守 `PI_CODING_AGENT_DIR`）下的 `extensions/pi-side-chat/config.json` 读取：

```json
{ "shortcut": "alt+/" }
```

唯一后端是同进程 SDK。已设置的 `PI_SIDE_BACKEND`（包括空值）、`defaultBackend`、`extensionCommands` 会禁用 Side/BTW 并明确报错；其他未知字段沿用忽略行为。无效配置不阻止 Main 启动。修改配置后重启 Pi。
