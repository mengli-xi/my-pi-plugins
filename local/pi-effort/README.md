# pi-effort

## 用途

用 `/effort` 滑杆设置真实推理档位；`ultra` 可在工具确认后贡献委派提示。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

依赖统一在仓库根 `npm ci`，不在包目录另建 lockfile。目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

`/effort [档位|无歧义前缀|序号]`；档位只取当前模型支持的集合。`ultra` 固定最高真实档位，不向 Pi 传入虚构档位。配置为 `<agent-dir>/pi-effort.json`，提示覆盖为 `<agent-dir>/ultra-prompt.md`；缺文件使用默认值，坏文件禁用贡献而不改写。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

`prompt:fragments-v1` 由 Model Prompts 汇总；缺席时只改真实档位，不注入片段。ultra 还须确认当前 selectedTools 中有配置的委派工具，否则不贡献且提示一次。CC 缺席时状态栏 slot 不显示，命令照常可用。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-effort
npm test -w pi-effort
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/effort.md](docs/effort.md)：档位、ultra 配置、门控与滑杆动画。
