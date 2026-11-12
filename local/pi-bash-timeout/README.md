# pi-bash-timeout

## 用途

覆盖内置 `bash`，要求模型明确传入正数秒级 `timeout`，执行与结果仍由 Pi 拥有。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

Pi 版本见[根支持说明](../../README.md#支持说明)；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

没有配置文件或 slash 命令。`bash({command,timeout})` 的 timeout 必填、为正数，单位秒。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

通过 child-capabilities-v1 声明 required-only bash factory；Subagents 未装不影响 Main，父会话未加载本包时子会话沿用 builtin bash。

普通 child factory 的声明与共享装载规则见 [child-capabilities-v1](../pi-runtime-contracts/docs/child-capabilities-v1.md)；外部 provider grant 不由这个声明授予。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-bash-timeout
npm test -w pi-bash-timeout
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/bash.md](docs/bash.md)：bash schema、执行委托、child factory 与指纹。
