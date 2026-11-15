# pi-runtime-contracts

## 用途

不依赖 Pi 的进程内共享协议库，提供 lease/Wake、child 能力、进程等待桥和活动 DTO。

## 加载与构建

共享库，不加入 Pi packages；通过 workspace 依赖 import TypeScript subpath，无独立 build。

Pi 版本见[根要求](../../README.md#要求)；依赖在仓库根安装，见[根安装说明](../../README.md#安装与加载)。编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

不注册命令、timer、网络或 Pi extension。公开六个 subpath：`continuation-v1`、`child-capabilities-v1`、`provider-activity-v1`、`process-wait-bridge-v1`、`process-wait-bridge-v2`、`goal-continuation-obligation-v1`，无根导出。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

registry 只协调当前进程，不是权限沙箱；调用方负责释放。缺 Wake consumer 时 producer 自行降级；obligation 无 reader 返回 none，读者不可用或异常返回 unknown。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-runtime-contracts
npm test -w pi-runtime-contracts
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/continuation-v1.md](docs/continuation-v1.md)：lease/Wake API 与同步 consumer receipt 合同。
- [docs/child-capabilities-v1.md](docs/child-capabilities-v1.md)：普通 child factory 声明、冻结、装载、权限与失败合同。
- [docs/registries.md](docs/registries.md)：共享 registry 的版本、ABI 和降级。
- [旧 ABI fixture](test/fixtures/child-registry-abi1/README.md)：混合代际测试为何保留旧实现。
