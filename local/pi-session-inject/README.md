# pi-session-inject

## 用途

共享信箱 transport 与安全追加原语，负责持久接管、原生投递和可重放 ACK，不拥有业务结算。

## 加载与构建

共享库，不加入 Pi packages；通过 workspace 依赖 import TypeScript subpath，无独立 build。

Pi 版本见[根支持说明](../../README.md#支持说明)；依赖在仓库根安装，见[根安装说明](../../README.md#安装与加载)。编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

producer 调用 `bindMailbox`，首次绑定注册 `/mailbox` facade；单独安装本库不发现 producer。轻入口为 `pi-session-inject/mailbox-v1/light`。build ID 为 `mailbox-v1.0.6`，不兼容 holder 拒绝接入；编译消费者更新后须重建并启动新进程。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

业务 guard、身份、取消和成功判断归 producer，库只管 transport。恢复默认 hold，`/mailbox resume` 不替代业务授权；不可安全投影时 abort 并返回空列表，不把历史原文泄漏进请求。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-session-inject
npm test -w pi-session-inject
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

额外 real/native 套件统一用 `npm run check:upgrade -w pi-session-inject`；构建与完整验收规则见[升级 Pi](../../CONTRIBUTING.md#升级-pi)。

快速升级的本包宿主冒烟入口为 `npm run check:smoke -w pi-session-inject`；范围与放弃的保障见[升级规则](../../CONTRIBUTING.md#升级-pi)。

## 文档

- [docs/mailbox-v1.md](docs/mailbox-v1.md)：信箱格式、稳定身份、投递与恢复合同。
- [docs/operations.md](docs/operations.md)：transport 读取、投影、生命周期与验证。
