# pi-session-runtime

## 用途

共享有效请求捕获、上下文选择、原生 seed、隔离 SDK 装配和原生子视图交接。

## 加载与构建

共享库，不加入 Pi packages；通过 workspace 依赖 import TypeScript subpath，无独立 build。

Pi 版本见[根支持说明](../../README.md#支持说明)；依赖在仓库根安装，见[根安装说明](../../README.md#安装与加载)。编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

不注册配置或命令。调用方选择 `fork-turns`、`effective-context`、`native-child-context`、`session-assembly`、`sdk-provider`、`managed-interactive` 等 subpath。调用方拥有 Task 准入、grant、deadline 和释放；库不自动发现插件或 provider。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

普通 factory 按 [child-capabilities-v1](../pi-runtime-contracts/docs/child-capabilities-v1.md) 的已加载声明装载，模型/工具仍由调用方投影；外部 SDK provider 保持独立 grant，ambient 发现关闭。presentation 可选。stock Pi 1.5 可交接命名主题视图但不保证主题热更新，首次提示；补丁双面能力匹配才启用热更新，单面/未知拒绝，详见主题合同。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-session-runtime
npm test -w pi-session-runtime
npm run check:host -w pi-session-runtime
PI_BIN=/path/to/pi npm run check:host -w pi-session-runtime
```

离线测试直接读取已安装 Pi 的 `virtual-modules.js`，对照公开别名 key 集合，Pi 新增/删除别名会使测试失败。`check:host` 经真实 CLI loader 与实际 SDK child 比较 `StringEnum`、`openAIResponsesApi` 的对象身份，不发模型请求；默认检查仓库 Node CLI，可用 `PI_BIN` 检查编译版或 unbundled CLI。升级检查会运行本包 `test` 和 `check:host`。

补丁专用测试：`npm run test:patched-host -w pi-session-runtime`。需要匹配的补丁 SDK，不能用 marker fixture 替代。

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

快速升级的本包宿主冒烟入口为 `npm run check:smoke -w pi-session-runtime`；范围与放弃的保障见[升级规则](../../CONTRIBUTING.md#升级-pi)。

## 文档

- [docs/runtime.md](docs/runtime.md)：捕获、选择、seed、SDK realm 和视图交接。
