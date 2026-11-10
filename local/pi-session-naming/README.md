# pi-session-naming

## 用途

在会话完全空闲后，通过公开模型 API 为未命名会话生成短标题。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。先在仓库根运行 `npm run build -w pi-session-naming`。

目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

不注册命令，手动命名用 Pi `/name`。配置在 `<agent-dir>/extensions/pi-session-naming/config.json` 的 `overrides`：`enabled`、`model`（session 或 provider/model-id）、`effort`、`maxChars`、`timeoutMs`、`maxOutputTokens`。初始化时读取，手改后重载或重启。命名是额外模型请求，可能收费，内容与隐私边界见命名合同。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

CC 只用公开 session name 展示标题，缺 CC 不影响命名。`pi.perf.telemetry.v1` 缺席不记录遥测。指定模型不可用时跳过并提示，不静默换 provider；人工名称不被迟到结果覆盖。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-session-naming
npm test -w pi-session-naming
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/maintenance.md](docs/maintenance.md)：维护取舍、排障和验证入口。
- [docs/naming.md](docs/naming.md)：自动命名配置、请求内容、隐私与过期结果。
