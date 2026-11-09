# pi-model-capacity

## 用途

观察 provider 容量、订阅窗口和余额，发布不可变语义快照，不执行模型请求。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

依赖统一在仓库根 `npm ci`，不在包目录另建 lockfile。目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

`/usage` 显式刷新并查看所有已注册 adapter；TUI 用信息面板，RPC/headless 输出文本。内置 Codex、Grok、DeepSeek 观测；外部 adapter 通过注册协议接入。Codex 已结算使用量保存在 `<agent-dir>/codex-usage.jsonl`。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

发布 snapshot/request/watch V2 和 adapter 注册/ready V1；CC 仅展示，不拥有认证或轮询。无 watcher 不轮询，无 adapter 不伪造容量，无展示方仍可 `/usage`。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-model-capacity
npm test -w pi-model-capacity
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/capacity.md](docs/capacity.md)：adapter、snapshot/watch、认证、账户和生命周期。
