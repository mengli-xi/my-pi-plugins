# pi-native-search

给 Pi 增加 `web_search` 和 `web_fetch`。搜索优先使用当前 provider 的公共原生 API；不可用时走 DuckDuckGo。抓取直接用 HTTP，不适配 Claude 订阅的搜索或抓取，也不借用 `pi-claude-bridge` 的 SDK。

## 路由与凭据

| 当前 provider | 原生搜索 |
| --- | --- |
| `zai` | ZAI MCP `web_search_prime`（不是独立的付费 Web Search API） |
| `anthropic` | Messages API 的 `web_search_20250305` server tool |
| `google` | Gemini `google_search` grounding |
| `openai` | Responses API `web_search` |
| `xai` | Responses API `web_search` |
| `claude-bridge`、其他或未知 provider | DuckDuckGo；可选 backend 可通过显式协议提供路由 |

原生搜索每次调用都向当前 session 的 Pi model registry 获取有效凭据。本包不解析 OAuth 存储、不缓存 token、不读其他插件的私有配置或凭据。Anthropic 的直接请求只支持 API key；有效凭据是 OAuth token 时走 DuckDuckGo，不把 token 放进 `x-api-key`。

原生或可选 backend 执行失败后可回退 DuckDuckGo：回退成功会附上原生失败提示，两边都失败则保留两边的错误。发现协议无效或有冲突会直接报错，不偷偷选一个 backend。调用已取消时不再发起 fallback。降级不保证没有额外请求或费用，原生请求可能已被服务方处理。

## 配置

配置路径、字段和生效方式见 [配置](docs/configuration.md)。

## 加载与构建

当前基线是stock Pi 1.5。把本包目录的绝对路径加入 Pi `settings.json` 的 `packages`，由 manifest 加载 `extensions/index.ts`。`extensions/child.ts` 只供 Host 显式组装 SDK child，不作为普通 extension 加载。

这是 source-only package，没有 `dist/`，不需要 build。依赖由工作区管理；修改后运行检查，再启动新的 Pi process，不用 `/reload` 代替验证。

## 工具与命令

- `web_search { "query": "..." }`：搜索并把格式化结果交给模型。
- `web_fetch { "url": "https://..." }`：获取网页文本。HTML 会去掉脚本、样式和标签；JSON 会格式化。返回正文最多 50 KB / 2000 lines，超出会截断。

Main 注册以下命令；参数补全和 parser 使用同一组公开子命令，未知参数显示用法而不打开设置或修改配置。

| 命令 | 用途 |
| --- | --- |
| `/search` | 打开设置面板，列出已配置或当前使用的内置 provider |
| `/search providers` | 查看内置 provider 与原生搜索能力 |
| `/search config` | 查看当前配置、provider 和路由信息 |
| `/search on` | 打开总开关、搜索和抓取 |
| `/search off` | 关闭总开关 |

没有交互 UI 时不打开面板，命令降级为文本反馈；工具本身不依赖设置面板。状态栏只是路由能力提示，凭据和实际路由仍以每次执行为准。

配置文件是 `<agentDir>/search-config.json`。默认入口通过 Pi `getAgentDir()` 取目录；显式 Main 安装由 Host 传入目录，不猜用户 home。文件不存在时默认开启搜索和抓取；损坏配置或读取失败不会被当作“配置不存在”而默认启用。字段、版本缓存和写入规则见 [配置](docs/configuration.md)；SDK snapshot 规则见 [运行合同](docs/runtime-contract.md)。

## 可选协作与降级

- 其他 extension 可通过 `native-search:backends-request-v1` 注册搜索 backend。没人响应时保留公共原生搜索与 DuckDuckGo，不探测陌生 provider 的配置、凭据或模块。backend 的协议、选择规则与撤销语义见 [backend 合同](docs/backends.md)。
- Main 可通过共享 child capability registry 声明 `web_search`、`web_fetch`。没有 child Host 消费该能力也不影响 Main；SDK child 由 Host 显式传入配置 snapshot 和可选的 Main discovery emitter。child 不注册命令、写配置、呈现状态或修改 Host active-tool allowlist。详见[运行合同](docs/runtime-contract.md)。
- 本包不依赖、import 或自动安装另一个插件。私有服务和默认 provider 映射由独立集成负责。

## 数据与信任边界

搜索 query 会发给所选原生服务、可选 backend 或 DuckDuckGo；HTTP 抓取会把 URL 发给目标站点。返回内容会成为工具结果进入模型上下文，可能由当前模型服务处理。不要把秘密放进 query 或 URL；网页内容不应当作可信指令。

可选 backend 是同进程运行的可信代码，不是沙箱。发现协议不直接携带凭据，但 backend 会收到执行 session 的公开 context；安装前应审查它会访问什么、向哪里发请求。

50 KB / 2000 lines 只限制 HTTP 抓取返回给模型的正文，不限制下载量。HTTP 抓取不提供独立超时或 SSRF 防护承诺，不能把它当作网络隔离边界。

普通 child factory 的声明与共享装载规则见 [child-capabilities-v1](../../local/pi-runtime-contracts/docs/child-capabilities-v1.md)；外部 provider grant 不由这个声明授予。

## 验证与使用回归

在已准备依赖的工作区中运行：

```bash
cd fork/pi-native-search
npm run typecheck
npm test
```

包内检查使用离线 HTTP fixture 和 faux provider，覆盖本包工具、配置、凭据、backend 协议及 Main/SDK child 合同（含 Subagents/Side 双 target 与执行文件完整性证明）；不需要真实 provider 请求。跨插件协作与缺失协作方的联测放在仓库 `integration/`，不能用本包测试替代。

启动新的 Pi process 后，按需检查这些使用路径；真实搜索和抓取会外传数据并可能计费，先确认目标和授权：

1. 查看 `/search config`、`/search providers`，检查空 prefix、部分 prefix 和未知参数的补全与命令反馈。
2. 用 `/search off`、`/search on` 验证工具开关；切换 provider 后核对配置与路由。
3. 检查公共原生搜索、无凭据或未知 provider 的 DuckDuckGo 路由，以及 HTTP 抓取与截断提示。
4. 在受控 fixture 中检查 native 失败、双重失败和取消；取消后不得继续 fallback。
5. 如使用 SDK child，检查独立 snapshot、Host 工具白名单不变，以及可选 backend 缺失、撤销后的降级。

## 文档

- [配置](docs/configuration.md)：配置来源、字段、默认值与生效方式。
- [运行合同](docs/runtime-contract.md)：Main/SDK child 安装、snapshot 与生命周期。
- [backend 合同](docs/backends.md)：版本化发现协议、路由、校验、生命周期和 SDK emitter。
- [LOCAL_PATCHES.md](LOCAL_PATCHES.md)：Fork 保留这些差异的原因与当前兼容边界。
- [LICENSE](LICENSE)：MIT。
