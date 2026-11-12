# pi-cc-memory

## 用途

按项目保存 Markdown 记忆，并向会话注入冻结索引；模型用普通文件工具维护记忆。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

Pi 版本见[根支持说明](../../README.md#支持说明)；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

`/memory [主题]` 只读查看。数据位于 `<agent-dir>/pi-cc-memory/projects/<identity-hash>/memory/`；索引为 `MEMORY.md`，单次注入最多 200 行或 25,000 UTF-8 字节。身份、刷新和公开材料接口见下方记忆合同。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

通过 `statusline:row` 提供 memory 行，CC 缺席时无状态栏，不报错。`cc-memory:request:materials-v1` 提供只读材料，`cc-memory:request:project-v1` 保留旧读取兼容；无人请求不额外读正文。不自动装入 SDK child。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-cc-memory
npm test -w pi-cc-memory
npm run check:host -w pi-cc-memory
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/memory.md](docs/memory.md)：项目身份、存储、冻结索引、材料协议与恢复。
