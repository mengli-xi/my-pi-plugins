# pi-session-compact

## 用途

压缩当前会话，保留完整用户原话、文件清单和可选 owner 恢复材料。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

`/compact [instructions]`；`/compaction now [auto|main|small] [focus…]`、`window [tokens|off]`、`show`、`reserve [write]`。工具为 `session_search`、`session_expand`。配置在 `<agent-dir>/pi-session-compact/config.json`；默认 main，不内置 smallModel；`summaryTokens` 只读兼容且不控制容量。具体语法、重试和存储合同见下方文档。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

收集可选 recovery/material 协议，缺 Todo/Subagents/技能 owner 时不取消压缩；缺 Memory 时材料为空。CC 缺席不显示 CP 行，压缩照常运行。有效前缀不可用时按合同转 small/native；本包应是 profile 唯一 session_before_compact owner。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-session-compact
npm test -w pi-session-compact
npm run check:host -w pi-session-compact
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/compaction.md](docs/compaction.md)：压缩、原话、容量、检索和故障合同。
- [docs/provider-activity.md](docs/provider-activity.md)：provider 活动 DTO 与压缩时钟。
