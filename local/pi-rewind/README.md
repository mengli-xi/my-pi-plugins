# pi-rewind

## 用途

线性裁剪 Pi 会话并保留可校验的恢复归档；不撤销工作区文件改动。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

Pi 版本见[根支持说明](../../README.md#支持说明)；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

空且 idle 编辑器双 Escape 或 `/rewind`；`/rewind undo` 恢复最近裁剪，`/rewind history` 查看归档。归档位于 `<agent-dir>/rewind-trash/`，恢复须 session/leaf/文件摘要均匹配；保留 7 天、100 条、500 MiB，先到为限。`PI_REWIND_TRACE_LOG` 可记录分段耗时。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

CC 的 `pi.claude-style.editor-image-source.v2` 提供图片源恢复回执；缺 owner、版本不符或文件失效时整体退回无路径 `[Image]`。不要求 patched host。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-rewind
npm test -w pi-rewind
npm run check:internals -w pi-rewind
npm run check:host -w pi-rewind
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

快速升级的本包宿主冒烟入口为 `npm run check:smoke -w pi-rewind`；范围与放弃的保障见[升级规则](../../CONTRIBUTING.md#升级-pi)。

## 文档

- [docs/rewind.md](docs/rewind.md)：裁剪、归档、恢复、并发保护与图片回退。
