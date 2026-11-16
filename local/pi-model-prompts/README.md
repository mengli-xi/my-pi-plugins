# pi-model-prompts

## 用途

按模型读取规则和命名提示词，汇总可选插件片段，追加到本次系统提示词。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

Pi 版本见[根要求](../../README.md#要求)；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

完整配置说明见 [配置](docs/configuration.md)。

`/model-prompt` 查看，`/model-prompt settings` 选择命名提示词及模型绑定。配置位于 `<agent-dir>/model-prompts/`：`<model-id>.md`、`prompts/<name>.md` 和 `bindings.json`；下次 run 读取文件变化，不改写用户提示词。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

`prompt:fragments-v1` 同步收集 Map 片段；Effort 缺席时仍汇总文件来源。缺失/空文件不贡献，坏文件给安全诊断，不阻断普通请求。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-model-prompts
npm test -w pi-model-prompts
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [配置](docs/configuration.md)：配置来源、字段、默认值与生效方式。
- [docs/prompts.md](docs/prompts.md)：提示片段汇总、公开协议与查看验证。
