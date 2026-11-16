# 🎯 pi-goal — 持续推进并验证目标

[![npm](https://img.shields.io/npm/v/@narumitw/pi-goal)](https://www.npmjs.com/package/@narumitw/pi-goal) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Goal 为当前 Pi session 提供 `/goal`、`goal_complete` 和 `goal_blocked`。模型结束一轮但还没完成时，Goal 等 Pi 真正 settled 再继续；默认最多推进 **25 次 Goal-owned model responses**，并在连续 **3 次无工具、空白或重复输出**后暂停。它不会仅凭一句“完成了”结束目标，也不能独立证明模型的完成声明。

## ✨ 能做什么

- 目标、累计 token、活动时间、安全计数和可选队列跟随 session/branch，不按工作目录共享。
- 支持 token budget、暂停/恢复、编辑目标和默认关闭的有序目标队列。
- 过期 `goal_id`、失去 terminal tools、暂停和预算耗尽都有独立保护。
- 自动投递使用 durable mailbox；恢复和取消失败会保留可见 hold，不静默丢工作。
- 单独加载即可用。不需要 Processes、Subagents、CC Style 或宿主 patch；共享库是运行依赖，不是协作插件。

## 📦 加载与构建

本 Fork 的 stock Pi 版本见[根要求](../../README.md#要求)，使用根 workspace 和唯一根 `bun.lock`；bun 同时用于安装和构建。只安装信任的 extension，它与宿主具有同等进程权限。

按[根安装说明](../../README.md#安装与加载)在仓库根安装依赖，再构建并加载本包：

```sh
npm run build -w @narumitw/pi-goal
pi -e "$PWD/fork/pi-goal"
# 持久启用：
pi install "$PWD/fork/pi-goal"
```

Pi 加载 `dist/index.js`，不会自动构建。改 Goal 源码或 source-only 共享库后，**显式 rebuild，再启动新 Pi process**；`/reload` 不能替代这一步。保留 Bun splitting 和 `pi-session-inject/mailbox-v1/light` 的首次使用边界，不要求 Pi private seam。

上游 npm 包可用 `pi install npm:@narumitw/pi-goal` 安装，或 `pi -e npm:@narumitw/pi-goal` 临时试用；这不是本地 Fork 的分发方式，不能假定包含本地 mailbox/UI 补丁。安装和维护边界见 [维护说明](docs/maintenance.md)。

## 🚀 常用命令

```text
/goal                         # TUI 管理菜单
/goal --tokens 100k 修复问题并验证
/goal status
/goal pause
/goal resume
/goal edit 先完成较小的修复
/goal edit                    # 编辑器预填当前目标；/goal modify 也可使用
/goal idle-checkin 20m         # 后台等待巡检；off/default 也可用
/goal clear
```

`--tokens` 可省略，支持 `100k`、`1.5m`。目标最多 4,000 字符，更长内容放文件再引用。启用 `experimental.goals` 后，可用 `add`、`prioritize`、`drop-last`、`skip`；仍只有 `/goal` 一个命令入口。

**暂停 Goal 不会杀掉它启动的后台 process 或 Subagent Task，也不会延长或取消它们的 deadline。** 后台结果仍可唤醒对话，模型可以读取、检查和记录，但不能推进或结束已暂停的 Goal；只有 `/goal resume` 才恢复推进。需要停止后台工作时，使用生产方自己的取消操作。

完整语法、模式限制、兼容 alias、替换确认和失败回滚见 [命令合同](docs/commands.md)。

## 配置

设置路径、默认值、菜单与命令保存、生效时间见 [配置](docs/configuration.md)。

## 🤝 可选协作与降级

- CC Style/Compact 可消费 Goal 自己发布的 `goal:snapshot-v1`；没有消费者时保留原生 status，Goal 照常运行。
- Processes/Subagents 可通过共享 continuation 协议交接后台结果；缺生产方时 Goal 普通续跑不变，不读取对方私有存储。
- 现有 managed RPC 是**无版本、默认关闭的旧兼容接口**，不是新版本化 API，也不是权限沙箱。
- mailbox 是共享库硬依赖。没有有效 transport owner 或恢复证据时保留 pending/hold，不绕到私有 native 队列。

完整字段、缺失方行为和兼容范围见 [协议合同](docs/protocols.md)，持久投递见 [Mailbox 合同](docs/mailbox.md)。

## ✅ 验证

从仓库根运行 `npm run typecheck`、`npm test` 和 `npm run test:integration`。包内只放 Goal 离线单元/合同测试及不加载协作插件的 faux e2e；跨插件用例见根 [integration](../../integration/README.md)。stock CLI smoke 与完整矩阵需要额外显式入口，不能把默认离线检查当作它们已通过；见 [维护说明](docs/maintenance.md)。不发真实 provider 请求，不发现日常 profile。

额外 real/native 套件统一用 `npm run check:upgrade -w @narumitw/pi-goal`；构建与完整验收规则见[升级 Pi](../../CONTRIBUTING.md#升级-pi)。

## 🗂️ Package layout

- `src/index.ts`：薄入口；`goal.ts`、`commands.ts`、`runtime*.ts`：生命周期、命令与运行 authority。
- `src/persistence.ts`、`queue.ts`、`safety.ts`、`accounting.ts`：branch 状态、队列、安全与记账。
- `src/mailbox*.ts`：冻结 source intent、transport 对接与离线回滚投影。
- `src/prompts.ts`、`settings*.ts`、`run-protocol.ts`、`goal-snapshot.ts`：提示、设置和公开协作。
- `test/`：本包测试；`dist/`：显式构建产物，不提交。

## 完整合同

- [命令](docs/commands.md)：全部语法、TUI/RPC/print/JSON 边界、队列与回滚。
- [配置](docs/configuration.md)：默认值、路径、兼容字段、工具可见性、保存与失败。
- [生命周期与安全](docs/lifecycle.md)：25+3、token/时间、完成审计、暂停、重试、branch 与旧记录。
- [Mailbox](docs/mailbox.md)：durable 投递、owed receipt、恢复 hold、lineage、取消和离线恢复。
- [协议](docs/protocols.md)：snapshot、continuation/obligation 和旧 managed RPC。
- [开发约束](docs/extension-conventions.md)：Goal 的依赖、生命周期、命令、UI 与验证规则。
- [设置开发约束](docs/extension-settings.md)：设置的校验、持久化、交互与兼容规则。
- [维护](docs/maintenance.md)：vendor 单包原版、workspace/build、检查边界与当前本地意图。

## 🔎 Keywords

Pi extension, goal mode, autonomous coding, verification, token budget, durable mailbox.

## 📄 License

MIT，见 [LICENSE](LICENSE)。
