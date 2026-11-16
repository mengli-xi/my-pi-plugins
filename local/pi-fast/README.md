# pi-fast

## 用途

`/fast` 为 `openai-codex`（ChatGPT OAuth）provider 的请求增加 `service_tier: "priority"`。登录仍使用 Pi 的 `/login`，本包不改变认证或模型选择。

## 加载

Pi 版本见[根要求](../../README.md#要求)；按[根安装说明](../../README.md#安装与加载)安装依赖后直接加载 TypeScript，无 build/dist：

```sh
pi -e "$PWD/local/pi-fast"
```

## 命令与持久化

| 命令 | 行为 |
| --- | --- |
| `/fast`、`/fast on\|off` | 切换或设置当前 session 的分支级 override |
| `/fast all`、`/fast all on\|off` | 切换或设置全局默认，并清除当前分支的 override |
| `/fast status` | 显示实际生效状态及作用域，不修改状态 |

## 配置

配置格式、session 优先级、持久化与失败处理见 [配置](docs/configuration.md)。

## 请求作用域

`before_provider_request` 接收即将发送的 JSON body；主 agent loop 的 SSE、WebSocket 通过同一 payload seam 注入。

- 影响主 agent loop 请求。
- **stock Pi 1.5 原生 compaction 不受影响**：它直接调用 `agent.streamFunction`，未经过 Agent 的 `onPayload`，不会触发此 hook。
- 本仓库 [pi-session-compact](../pi-session-compact/README.md) 的压缩生成也不受影响：main/small（含 chunk、synthesis）和该插件的 native fallback 经 `src/generate.ts` 直接调用 `ctx.modelRegistry.streamSimple`，不传 `onPayload`。继承主请求的消息前缀不等于继承请求 body 的 `service_tier`；本包不会为这些压缩请求增加 priority。
- **Subagents 与 Side Chat 跟随创建时的父状态**：Main 通过 [child-capabilities-v1](../pi-runtime-contracts/docs/child-capabilities-v1.md) 注册 `child.ts` 的 `createFastChildFactory`，子 session 安装相同的请求 hook。创建时捕获实际生效的 fast 状态（session override 优先，否则全局默认），后续父状态变化不改已有 child；child 不注册 `/fast`，不写父 override 或全局文件。不加载本包时 child 请求照常。其他 SDK 消费者只有明确消费该声明才会跟随。Main binding 按 session ID 管理，shutdown 释放全部 binding 和 registration；binding 失败只给诊断，不影响 `/fast` 与主请求注入。
- 直接调用 `modelRegistry` stream 的扩展绕过此 hook，不受影响。
- 仅在 fast 生效、`ctx.model.provider === "openai-codex"`、payload 是含字符串 `model` 的对象且没有 `service_tier` 时注入。其他 provider 不变；已有 tier（例如 `models.json` override）优先，原 payload 不被原地修改。

本包只请求 priority tier，不保证服务端速度、实际 tier 或订阅消耗。pi-ai 的 priority 成本倍率取决于 stream option 与响应回显；payload 注入未必反映在显示成本中，不能据此判断实际服务等级或用量。

## 可选状态栏协作

通过 `statusline:row` 向 CC Style 贡献 `key: "fast"`、`placement: "slot"`，填充 `[[pi:slot:fast]]`：支持该 provider 且开启时显示黄色 `⚡`，支持但关闭时显示 dim 图标，不支持时隐藏。合同见[状态栏贡献项](../pi-claude-style/docs/statusline-provenance.md#首帧刷新与贡献项)。slot 更新不需要重新运行状态栏命令；主 turn 开始时也会刷新，以跟上其他 session 写入的全局默认。

没有 CC Style 时贡献无人接收，静默降级，`/fast` 通知和请求注入仍正常，不依赖插件加载顺序。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-fast
npm run test -w pi-fast
npm run build -w pi-claude-style
node --test integration/fast-statusline.test.ts
```

包内测试覆盖 child factory 直接注入/不注入、shutdown 后变更声明重新注册、binding 失败降级、分支恢复、全局默认、写入失败及独立 SDK 的主请求及原生 compaction/直接 stream 不注入边界；跨插件双加载顺序测试见[根 integration](../../integration/README.md)。测试使用临时配置与 faux provider，不发真实 provider 请求，不证明真实服务端性能或人工终端表现。

## 文档

- [配置](docs/configuration.md)：配置来源、字段、默认值与生效方式。
