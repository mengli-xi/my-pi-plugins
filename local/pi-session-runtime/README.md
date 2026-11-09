# pi-session-runtime

## 用途

共享有效请求捕获、上下文选择、原生 seed、隔离 SDK 装配和原生子视图交接。

## 加载与构建

共享库，不加入 Pi packages；通过 workspace 依赖 import TypeScript subpath，无独立 build。

依赖统一在仓库根 `npm ci`，不在包目录另建 lockfile。目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

不注册配置或命令。调用方选择 `fork-turns`、`effective-context`、`native-child-context`、`session-assembly`、`sdk-provider`、`managed-interactive` 等 subpath。调用方拥有 Task 准入、grant、deadline 和释放；库不自动发现插件或 provider。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

显式 factory/模型/工具由调用方批准，ambient 发现关闭。CC presentation 可选。原版 Pi 1.5.0 可交接命名主题视图但不保证主题热更新，首次提示；补丁双面能力匹配才启用热更新，单面/未知拒绝，详见主题合同。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-session-runtime
npm test -w pi-session-runtime
```

补丁专用测试：`npm run test:patched-host -w pi-session-runtime`。需要匹配的补丁 SDK，不能用 marker fixture 替代。

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/runtime.md](docs/runtime.md)：捕获、选择、seed、SDK realm 和视图交接。
