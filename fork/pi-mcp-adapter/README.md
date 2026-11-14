# Pi MCP Adapter

让 Pi 按需发现和调用 MCP tools，也支持 resources、prompts、elicitation、sampling、Apps 和异步 Tasks。默认通过 `mcp` gateway 搜索与调用，避免把全部 schema 常驻在模型上下文中；需要时也能注册 direct/deferred tools。

本地包以 **npm `pi-mcp-adapter@7.0.1`、stock Pi 1.5** 为兼容基线。[本地维护意图](LOCAL_PATCHES.md)只解释当前 patch 为什么存在，不代表上游 `main` 的 Unreleased 改动已经包含在此包内。

## 加载与构建

在本仓库安装 workspace 依赖后，从包目录执行：

```bash
npm run build
```

Pi package profile 加载本包目录，extension 入口是 `dist/index.js`。构建逐文件 transpile runtime，复制 runtime assets 并生成 public declarations，**不 bundle**；依赖保持 external。`dist/` 不提交，修改源码或 source-only 共享库后必须重建，再启动新 Pi process。不能用 `/reload` 代替 rebuild/restart。重新 build 保留最近两版，已运行会话沿用原版，新会话才用新版；连续重建前须重启更早的会话；从旧的扁平 dist 首次升级时，已运行会话仍须重启一次。

`pi-session-inject` 是 source-only **共享库硬依赖**，不是要额外启用的插件。Apps、后台 OAuth 和 Task 结果共用其 durable mailbox；本包不 import CC Style 或其他插件，也不需要 Pi patch。冷启动从 `pi-session-inject/mailbox-v1/light` 接入；实际投递、恢复或 mailbox 操作才加载共享 engine。semantic search、Apps、panel/setup 与 OAuth 实现仍保持首次使用的 cold import 边界。

## 快速使用

项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.6.0"]
    }
  }
}
```

```js
mcp({ search: "screenshot" })
mcp({ describe: "chrome_devtools_take_screenshot" })
mcp({ tool: "chrome_devtools_take_screenshot", args: { format: "png" } })
```

`lazy` 默认不让服务器常驻：已有有效 metadata 时，搜索/describe 可以离线完成；**首次缺少 metadata、配置改变、cache 损坏或 server TTL 到期时，默认仍会 discovery 连接**，读取工具列表后断开普通 lazy server。`deferWithMissingMetadata: true` 可把 discovery 推迟到首次 MCP 操作，但工具、prompt、resource 暂不可见。不能据此承诺首次运行绝不联网。

项目服务器还要经过 Pi project trust 和 Adapter 的 server approval。默认空闲 10 分钟断开；调用、审批、开放的 UI 和 Tasks 会延长连接。HTTP/socket 断开只关闭 client，不会关闭远端服务。

## 7.x 的功能与兼容边界

- **脚本**：`mcpScript` 已删除，用 Pi `codemode`；在 Pi `defaultTools` 添加 `"+codemode"`。重复流程用 `scriptTools` 保存为工具。旧脚本的 `{ ok, data }` 返回包装不再适用。
- **语义搜索**：`settings.semanticSearch` 通过 Pi classifier/model registry 和 Pi 登录调用模型，不恢复旧 Jev/System One SDK、独立 service key 或 endpoint。普通词法搜索不调用模型。
- **Extraction**：默认关闭；只有 `settings.extraction.allowedServers` 明确允许的 server，且调用带 `extract`，才把该工具结果的可提取文本发给 Cloudflare Clairic。授权意味着允许这部分数据离开本机，并非本地过滤。
- **Tasks**：server 设置 `protocolVersion: "auto"` 或 `"2026-07-28"`，且宣告 Tasks extension 后，交互式普通调用可立即返回 handle，结果经共享 mailbox 投递；code/UI/headless 调用仍等待结果。
- **目录披露**：`roots` 默认 `true`，会向 MCP server 披露 Pi session cwd；不需要时对该 server 设置 `"roots": false`。
- **凭据**：Adapter 自己已有的 URL-bound credentials 继续使用。它不读取、导入或删除 Pi 内建 MCP 的私有登录态；过去只依赖 native sign-in import 的用户需重新 `/mcp-auth <server>`。公开 Pi provider token 接口不受此限制。

完整行为分别见下方本地文档。上游旧 host 的启动时间、内存或 token benchmark 不构成本包在 stock Pi 1.5 上的实测或承诺。

## 配置与命令

Pi 路径由公开目录发现接口解析，Claude/Codex import 尊重各自环境 override；常规 home 路径只作 fallback。普通来源包括共享 `.mcp.json`、user-global MCP 文件、Pi 的 `mcp.json` 和 `mcp-adapter.json`。精确优先级、exclusive mode、trust、setup 写入目标见[配置](docs/configuration.md)。

| 命令 | 用途 |
|---|---|
| `/mcp-adapter`、`/mcp` | server 面板；连接、direct/proxy 切换、启停、OAuth |
| `/mcp-adapter setup` | 发现配置、选择 import/preset、预览差异后写入 |
| `/mcp-adapter semantic setup` | 选择可发送工具 metadata 的 server，保存 project 设置 |
| `/mcp-adapter edit [project\|global]` | 编辑共享 MCP JSONC；Ctrl+G 打开 `$EDITOR` |
| `/mcp-adapter status`、`tools`、`prompts` | 状态、工具和已注册 prompt 命令 |
| `/mcp-adapter tasks [stop <server>/<taskId>]` | 查看/停止后台任务 |
| `/mcp-adapter reconnect [server]` | 重连全部或指定 server |
| `/mcp-adapter disable <server>`、`enable <server>` | 写项目 override，reload 后应用 |
| `/mcp-adapter logout <server>` | 清除 Adapter OAuth credentials 并断开 |
| `/mcp-auth [server]` | 指定 OAuth server；无参数时在交互 UI 选 server |
| `/mcp-adapter token status <server>`、`token remove <server>` | 管理静态 bearer token 的非秘密状态 |
| `pi-mcp-adapter init`、`doctor [--json]` | CLI 配置 import 与连接诊断 |
| `pi-mcp-adapter token set <server>` | 终端 masked input 或 stdin 写入 bearer token |

命令补全只展示实际 canonical grammar 和符合资格的 runtime server；未知输入返回 `null`。`autoAuth` 默认关闭，开启后 connect/tool 遇到 needs-auth 会走 OAuth，再重试一次。

## 可选协作与降级

其他 extension 通过 versioned event/API 注册 server、调用工具、读取状态或扩展 MCP protocol；没有 Adapter listener 时必须自行处理不可用，不能解析私有 session entries。状态用 `pi-mcp-adapter/status/v1`。审批事件 `pi-mcp-adapter:tool-approval-request` 是保留兼容的 **legacy 名称**，无 listener 或 `abstain` 回到 Adapter 自有审批；host-managed mode 则拒绝执行。新协议都带版本号。

Apps/OAuth/Tasks 没有可用 mailbox transport 时显式报告，**不走第二条 native send/wake 路径**。CC rendering、其他插件和加载顺序不应成为本包独立加载的前提；shared Inject library 是另外一回事。完整接入与降级见[扩展 API](docs/extension-api.md)和[mailbox](docs/mailbox.md)。

## 验证

在包目录运行：

```bash
npm run typecheck
npm test
npm run build
npm run test:public-exports
npm run check:host
```

包内 gate 包含现行四份 Vitest 合同（completion、cold-loading、mailbox、UI action）、新行为回归、public exports 与 stock-host faux-provider 检查。测试应隔离 HOME/agent/cwd/session，禁止真实 provider 请求与用户配置写入；host gate 使用新 process 和已构建 dist。它们不等于 npm 包缺失的上游 OAuth/conformance 全套。真实 CC/Inject/SDK 联测与“缺少可选插件”的降级测试放根 `integration/`，不在包内加载其他插件。本文列的是运行方法，不宣称这些命令已执行或通过。

官方二进制验收跳过本包 dist SDK 探针：它必须从 npm 宿主目录 import SDK 并由 Node 执行 CLI；二进制的生产 dist 加载由根全插件冒烟覆盖。

日常使用时顺手回归的步骤与预期见[使用回归](docs/usage-regression.md)。

## 限制

- 每个 Pi session 通常有独立 MCP process；显式 `rmcp-mux` 可共享，但共享 server 的状态/凭据边界要自行控制。
- compact rendering 只压缩 Adapter 文本；图片仍由 Pi 控制，Pi 自己的 separator row 也不会消失。
- sampling 只支持文本；context inclusion、tools、stop sequences、audio/image 请求会明确拒绝。
- cache 只是 metadata，不是离线 tool executor；最终调用仍需连接 server。

## 文档目录

每份 active 文档都从这里直接可达；按需阅读，不必一次读完。

| 文档 | 完整合同 |
|---|---|
| [配置](docs/configuration.md) | 文件发现、override、优先级、trust、lifecycle、全部 settings 与 scriptTools 配置 |
| [Server](docs/servers.md) | 全部 server 字段、transport/TLS、protocol、Tasks、stdio 隔离、socket 与 URL install |
| [认证](docs/auth.md) | OAuth、callback、secure store、实时只读状态检查、provider/bearer/header/secret command |
| [工具](docs/tools.md) | gateway/search/direct/deferred、approval broker、schema、output guard |
| [脚本与模型](docs/scripting.md) | Pi classifier、extraction 数据披露、codemode、scriptTools 与保存 |
| [Prompts 与 Apps](docs/prompts-and-ui.md) | prompt、elicitation、sampling、Executor、UI consent 与交互 |
| [扩展 API 与 SDK](docs/extension-api.md) | plugin/package 来源、runtime event、public exports、SDK/host-managed 与 status |
| [Protocol extensions](docs/protocol-extensions.md) | 自定义 request/stream/notification 的权限与生命周期 |
| [Durable mailbox](docs/mailbox.md) | Apps/OAuth/Tasks 身份、lineage、payload、ACK、owner 与恢复边界 |
| [与内建 MCP 的关系](docs/pi-builtin-comparison.md) | ownership、选择依据与不作性能承诺的边界 |
| [使用回归](docs/usage-regression.md) | 使用功能时可顺手检查的 case 与安全测试前提 |
