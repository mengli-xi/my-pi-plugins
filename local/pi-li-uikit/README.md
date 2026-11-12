# pi-li-uikit

## 用途

共享 TUI 面板、选择器、滚动、折叠、鼠标命中和剪贴板组件，不拥有业务流程。

## 加载与构建

共享库，不加入 Pi packages；通过 workspace 依赖 import TypeScript subpath，无独立 build。

Pi 版本见[根支持说明](../../README.md#支持说明)；依赖在仓库根安装，见[根安装说明](../../README.md#安装与加载)。编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

不注册命令或配置。调用方只 import 所需 subpath，如 `pi-li-uikit/text-panel`、`information-panel`、`editor-panel`；完整导出与组件合同见下方文档。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

CC 可发布 `pi.pinned-layout.editor-slot-geometry.v1` resolver；缺失时共享 mount 使用原生布局估算。组件只消费宿主已解码的鼠标事件，不开启终端鼠标模式。业务和跨模态流程留给调用方。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-li-uikit
npm test -w pi-li-uikit
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/clipboard.md](docs/clipboard.md)：系统剪贴板与 OSC 52 边界。
- [docs/components.md](docs/components.md)：公开组件 API、布局、输入与鼠标合同。
