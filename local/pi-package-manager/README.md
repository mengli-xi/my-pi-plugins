# pi-package-manager

## 用途

用 `/plugins` 管理已配置包的启停、资源过滤、元数据和显式更新。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

Pi 版本见[根要求](../../README.md#要求)；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

本包没有专属配置项。

`/plugins` 无参数，仅交互 TUI。↑/↓ 选择，/ 或 Ctrl+F 搜索，Tab 切过滤，Space 启停，U 查更新，u 更新选中项，r 重载，Esc/q 关闭。不提供安装、移除或自动更新；使用 Pi 的 `pi install`、`pi remove`、`pi config`。备份与原子性边界见管理合同。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

只硬依赖 UIKit，不依赖 CC；无图形 TUI 时说明不可打开，不改配置。不读未受信项目。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-package-manager
npm test -w pi-package-manager
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/management.md](docs/management.md)：包启停、filter 备份、显式更新与失败恢复。
