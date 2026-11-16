# pi-session-naming

为 Pi session 自动生成 Claude 风格的名称。未命名 session 到达 Pi 完全 settled 的 boundary 后，extension 会通过公开的 `ModelRegistry.complete` path 请求短标题，并用 `pi.setSessionName` 写入。只支持 stock Pi 1.5 的公开 completion API。Pi 拥有 terminal title 与 session selector；`pi-claude-style` 是 editor chrome 的唯一 presentation owner，它通过公开的 `pi.getSessionName()` 与 `session_info_changed` 展示同一名称。本包不读取 Git，也不安装 editor render/input wrapper。

配置文件、模型选择、生效方式和迁移规则见 [配置](configuration.md)。

默认 request 优先关闭 reasoning；模型不接受 off 时，选择其公开 thinkingLevelMap 支持的最低档位。输出限制为 128 token，并在 15 秒后 abort；三项 policy 都可配置。会转发实际 Pi session id，因为 native provider 依赖它维持 request affinity。

这是额外的模型请求，不是免费的本地格式化：取 `agent_end` 消息列表中首个 user 的前 1,500 和末个 assistant 的前 1,000 个 UTF-16 code unit，作为截断原文发送，不做匿名化。不发送图片、tool result 或完整 session；不向主对话插入命名提示词，也不依赖 `pi-model-prompts`。每次 session start 周期最多尝试一次，失败后该周期不自动重试。人工名称和新 session 不会被迟到结果覆盖。

模型标题视为不可信终端文本，先清除 terminal escape、C0/C1 与 bidi control，再清理首行引号/标点并按 Unicode code point 限长。

启用 `pi-perf` 时，本包会经 telemetry v1 报告 completion 和端到端 naming latency、lifecycle count 与有界 outcome。它不安装 render / input wrapper、sampler、periodic timer 或 logger；只存在一个 in-flight request deadline。

## 验证与日常回归

本包从 `dist/index.js` 加载，source-only 修改后必须显式 build，并使用 fresh Pi process 验证；不提交 `dist` 或 `node_modules`。

```sh
bun install --frozen-lockfile # 在仓库根运行；以下验证命令在包目录运行
npm run check
```

检查在隔离 HOME/config/cache 中进行。真实命名请求可能收费，自动验证仅用 stand-in/faux provider，不接触日常 profile。

日常使用时确认：未命名 session 在 settled 后只请求一次；已有名称不请求；请求中人工 `/name` 不被覆盖；指定模型不可用或配置损坏时不回退/不调用；切 session 和 shutdown 的迟到结果无副作用。真实 provider、实际费用、terminal title 与 IME 需单独人工验收，未执行不能记为通过。

`<agent-dir>` 取 Pi 公开 getAgentDir()，遵守 PI_CODING_AGENT_DIR；要求 stock Pi 1.5。
