# pi-claude-style

## 用途

为 Pi 提供 Claude Code 风格的工具分组、Thinking、可点击的压缩摘要、编辑器装饰、工作指标和默认状态栏，不接管工具执行。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。先在仓库根运行 `npm run build -w pi-claude-style`。

目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

`/cc-style status|doctor|config|cache|perf`、`/tool-transcript [show|config]`、`/internals`；Alt+O 打开详情，Alt+T 折叠 Todo。私有配置位于 `<agent-dir>/extensions/pi-claude-style/config.json`，优先用 `/cc-style config get|set|reset <path>`。默认状态栏随包提供；在 Pi settings 的 `statusLine.command` 中覆盖，显式空值关闭。完整命令、字段和 loader 约束见界面行为合同。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

消费 Todo、Goal、Processes、容量和 provider activity 的公开语义协议；缺失时不显示对应领域状态，不启动对方。提供 `statusline:row`/`statusline:refresh`、child `presentation/claude-style-v1`、custom-entry presentation、编辑器图片源与 geometry 协议；DTO、校验和生命周期见运行时与界面合同。

普通 child factory 的声明与共享装载规则见 [child-capabilities-v1](../pi-runtime-contracts/docs/child-capabilities-v1.md)；外部 provider grant 不由这个声明授予。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-claude-style
npm test -w pi-claude-style
npm run check:internals -w pi-claude-style
npm run check:host -w pi-claude-style
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/behavior.md](docs/behavior.md)：界面行为、配置字段、loader 和宿主适配。
- [docs/important-tool-presentation-spec.md](docs/important-tool-presentation-spec.md)：工具、Activity、Thinking、图片与鼠标呈现。
- [docs/maintenance.md](docs/maintenance.md)：维护取舍、排障和验证入口。
- [docs/spec.md](docs/spec.md)：运行时、配置、协议与资源所有权。
- [docs/statusline-provenance.md](docs/statusline-provenance.md)：默认脚本、shell 数据边界、slot、刷新和回收。
