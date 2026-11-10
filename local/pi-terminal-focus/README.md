# pi-terminal-focus

## 用途

终端失焦时隐藏主编辑器的虚拟光标，聚焦后恢复，不改变输入焦点和草稿。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

没有配置或命令。终端/tmux 必须传递 DEC focus reporting；插件不改 tmux 设置。只处理主编辑器，不处理 overlay 或 SDK child。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

独立使用，不要求 CC/Rewind 或 host patch。宿主 render/probe 失配保留原生光标并提示；控制序列失败不阻断 Pi。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-terminal-focus
npm test -w pi-terminal-focus
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/focus.md](docs/focus.md)：失焦报告、光标包装、资源回收与兼容降级。
