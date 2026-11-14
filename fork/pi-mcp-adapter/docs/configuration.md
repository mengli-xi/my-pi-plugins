# 配置

本文定义文件发现、合并、trust、生命周期和 settings。工具 schema/暴露方式见[工具](tools.md)，server 单项字段见[Server](servers.md)。

## 面板与写入

`/mcp-adapter`（或 `/mcp`）显示 server 连接状态、工具与 direct/proxy 切换；可重连、Ctrl+D 启停，needs-auth 的 server 按 Enter 或 Ctrl+A 认证。没有 native sign-in import 或 Ctrl+P 导入。Save 默认 Ctrl+S，可映射 `mcp.panel.save`。

普通配置模式更新包后，首次 Pi session 可一次性展示跳过版本的 highlights 和 changelog 链接；程序化 supplied config 的嵌入 host 不显示。这是 UI onboarding 行为，不是本包已执行验证的记录。

Pi `keybindings.json` 可设置 `"mcp.panel.open": "alt+m"`（也接受 key 列表）；没有默认快捷键，打开时不清除正在输入的 prompt。

`/mcp-adapter setup` 选择项目 `.mcp.json` 或 user-global shared config，检查已发现文件、显式采用 host imports、打开路径、scaffold 最小配置、quick-add RepoPrompt，或添加 DeepWiki、Context7、Parallel Search、Tavily Search、Notion、GitHub、Chrome DevTools、Figma desktop 等 presets。每次写入先展示精确 before/after diff。GitHub preset 使用 `gh auth token`。

Figma remote 只接受已获准 client，不能保证 Pi client 可用。Desktop 方案需要付费计划的 Dev/Full seat：打开 Design file，Shift+D 进入 Dev Mode，在 inspect panel 开启 desktop MCP server，再从 setup 添加。

## 文件与目录发现

Pi agent/config directory 使用 Pi 公开发现 API，尊重实际进程环境和显式配置；`PI_CODING_AGENT_DIR` 影响该发现结果。下文 `<Pi agent dir>` 指解析后的目录，`~/.pi/agent` 仅是未配置 override 的惯常 fallback，不是硬编码 owner。项目 `.pi` 同样按当前 Pi 配置目录规则解析。

| 来源 | 用途 |
|---|---|
| `~/.config/mcp/mcp.json` | 首选 user-global shared config |
| `~/.agents/mcp.json`、`~/.agents/mcp/mcp.json` | tool-agnostic global compatibility 输入 |
| `<Pi agent dir>/mcp.json` | Pi 自有 server 配置输入 |
| `<Pi agent dir>/mcp-adapter.json` | global Adapter settings/imports/override |
| `.mcp.json` | 项目共享配置 |
| `.pi/mcp.json` | Pi 项目 server 输入 |
| `.pi/mcp-adapter.json` | 项目 Adapter settings/override |

`command`、`args`、`cwd` 的前导 `~/` 展开为当前 HOME；Windows 还支持 `~\`，POSIX 的反斜线保持文件名含义。`node`、`bunx`、`git` 等 bare command 由 PATH 解析。Agent Plugins 内建参数保持 literal，不套这层 expansion。

普通 Pi MCP 文件只读取 `mcpServers`，不读取 Adapter 的 top-level `settings`、`imports`、`claudePlugins`、`scriptTools`、`mcp-servers`。字段转换如下：

| Pi 字段 | Adapter |
|---|---|
| `command/args/env/cwd/url/headers/description` | 同名 |
| `type: stdio/http/streamable-http` | 转换后去掉 type |
| `enabled: false` | `disabled: true` |
| `timeout` 秒 | `requestTimeoutMs` |
| `oauth.clientId/clientSecret/scope/clientName` | 同名 |
| `oauth.callbackPort` | `redirectUri: http://127.0.0.1:<port>/callback` |
| `oauth.callbackUrl` | `redirectUri`；无 port 时采用 callbackPort 或 `{port}` |
| `exposure: direct/deferred/codemode/hidden` | `directTools: true/"search"/false` 或 disabled |
| `toolExposure` exact direct names | `directTools` 名单 |
| `toolExposure` hidden | `excludeTools`（可能比 Pi hidden 隐藏更多入口） |
| `auth: { provider }` | 同名，只允许 user-global |

Pi 拒绝的 entry 和 `type: "sse"` 跳过；无精确对应的 per-tool `codemode/deferred` 等忽略，保留 server-level 设置。忽略/跳过在每个文件每次启动报告一次，已加载 server 的面板也显示。`.pi/mcp.json` 同名 entry 整体替代 global Pi entry；Adapter 不写这两个文件，directTools 等写入同目录 `mcp-adapter.json`。Exclusive mode 不读取它们。

### 与内建 MCP 的 ownership

普通 file mode 下 Adapter 注册 `/mcp`，Pi 因而不加载同名内建 extension。为避免每次 startup/reload 警告，首次安装/更新启动时会在 user `settings.json` 的 `extensions` 写 `"-builtin:mcp"` 并通知；不改 project settings，已有 builtin entry 保持不动，所以用户在 `pi config` 重新开启后仍生效。显式 `--mcp-config` 或 factory `configPath` 不写这项设置。卸载 Adapter 后需自行在 `pi config` 开启内建 MCP。

`createMcpAdapter({ config })` 是隔离模式，不替代内建 `/mcp`，只注册 `/mcp-adapter`。Shell `pi mcp add/list/login/logout` 仍归 Pi 自己；Adapter 会读其 server config，但不读、导入或删除 native credential file。见[认证](auth.md)。

## 优先级与合并

由低到高：

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<Pi agent dir>/mcp.json`
5. `<Pi agent dir>/mcp-adapter.json`
6. opt-in ancestors，从远到近：`.mcp.json`、`<configDir>/mcp-adapter.json`
7. cwd `.mcp.json`
8. cwd `.pi/mcp.json`
9. cwd `.pi/mcp-adapter.json`

Host discovery fallback 低于全部普通来源；plugin/package 默认值也由普通配置覆盖。一般同名 server 逐字段合并，但 URL 改变时，不发送旧 URL 的 `headers`、bearer、OAuth 等凭据；普通 config/import 跨文件会在启动时提示两个来源。同 host 的 global/project 配置或 package/plugin 的 URL 替换也丢弃凭据，只是不发此提示。

`--mcp-config`/factory `configPath` 指定文件；`configPath` 高于 argv。`PI_MCP_CONFIG_MODE=exclusive` 只使用所选配置，不隐式加载普通配置来源。程序化 `config` 则是完全隔离快照，详见[SDK](extension-api.md#sdk-配置)。

### 祖先发现

默认不向上搜索。只允许 user-global source 或明确选中的 config 设置 `settings.ancestorConfigRoots`，例如 `["~/work/team"]`。每个 root 必须为显式 absolute 或 `~/...`，解析后存在且在 HOME 下；忽略不包含 canonical cwd 的 root，多项匹配只取最深者。Project 文件不能启用或拓宽边界。

在选中的 root 到 parent(cwd) 逐层读 shared/adapter 文件；近层覆盖远层，同层 adapter 覆盖 shared，cwd 最终胜出。不会越过 root 或 HOME。这只是 discovery 边界，不是 ownership/symlink sandbox，只配置可信 root。

`disable/enable <server>` 只把 `disabled` 写入最高优先级 project override，不改原 source、不复制凭据，reload 后更新 surface。程序化 `config` 不读写这个 override，也不提供这两个命令。

## Host imports

共享文件自动读；其他 client 仅作为 compatibility 输入：

```json
{ "imports": ["cursor", "claude-code", "claude-desktop", "opencode", "vscode", "windsurf", "codex"] }
```

`init` 检测并把缺失 import 写入 Adapter global config；setup 可显式采用。Claude Code 使用当前 `CLAUDE_CONFIG_DIR`，Codex 使用当前 `CODEX_HOME`，未提供 override 才用各自惯常 home fallback；检测和 import 必须使用同一个解析结果，不扫描另一个旧目录。

`settings.hostConfigDiscovery` 默认 `"off"`，普通 panel 不扫 host 文件；`"prompt"` 仅 detect/report；`"on"` 或 CLI `init --discover-host-configs` 才显式启用最低优先级 fallback。发现报告 paths/provenance/同名冲突，不写外部文件，也不能绕过 trust 静默运行命令。

OpenCode 只支持 V1 global `~/.config/opencode/opencode.json` 和 project `opencode.json` 的 `mcp`，project 字段覆盖 global。只 explicit import，不支持 V2、inline/managed/remote 配置。`environment` 是 canonical，兼容 `env`，二者同时存在时前者胜出。未知 schema keys 忽略并在 startup、panel、doctor 报告。

## Project server trust

项目 `.mcp.json`、project Adapter/Pi 文件、opted-in ancestors、project imports/plugins、repo host config，以及 project Pi settings 中 package 的 servers，不能仅因打开仓库就执行。Pi untrusted 时拦截；trusted TUI 首次连接前展示 source 与 command/URL，默认选 Don't allow。拒绝只对当前 session 生效，reload 可再问。

Approval 存在 Pi agent directory，绑定 canonical project、server 名和完整 effective definition；定义变化重新问。同一 repo worktree 对同 folder/definition 共享决策；支持 regular/bare/`--separate-git-dir`，后者 main checkout 因 git 未记录关联，单独询问。被阻止的 server 在 panel/status 显示原因。Project scriptTools 同样逐项批准。

Print/JSON/RPC 默认跳过未批准项目 server/script。User-global 或显式 config 的 `settings.projectServers: "allow"` 可允许 trusted headless，默认 `"ask"`，project 自己不能设置。`--mcp-project-servers allow` 则对该 process 的所有 session modes 允许 trusted project 未批准项，不持久化；untrusted 仍拒绝。Pi 可能把仅含 `.mcp.json` 而无 trust-requiring Pi resources 的目录视为 trusted，所以只对自己控制的目录使用此 flag。

Project server 不参与 extension-load 初始化，须等待 `session_start` 提供 trust。Explicit/programmatic config、global server 和 runtime registrations 保持各自正常规则。

## Doctor

`pi-mcp-adapter doctor [--json]` 按当前 cwd 配置逐个检查 enabled server，连接/列工具上限每个 15 秒，secret commands 使用自己的 timeout。输出 name/state（`ok/failed/needs-auth/blocked/disabled`）、toolCount 和 Adapter 可确认的错误/hint；enabled failed/needs-auth 时 exit 1，blocked/disabled 不算失败。不启动 OAuth，不打印 server output/body/secrets。

Doctor 使用匹配的 Pi 安装公开 trust/目录语义，不按 PATH 上另一个 daily `pi` 版本猜配置归属。无法获得 trust 时视为 untrusted；无 trust-requiring resources 的目录按 Pi 规则处理。没有 model registry 的 provider-token server 只报告 needs-auth。需要浏览器时在 Pi 运行 `/mcp-auth <server>`。

## Lifecycle 与 cache

| 模式 | 行为 |
|---|---|
| `lazy`（默认） | 无有效 metadata 时先 discovery 一次后断开；tool call 再连，idle 后断开 |
| `eager` | 启动连接，断线不自动重连；未显式 idleTimeout 时不 idle stop |
| `keep-alive` | 启动连接；remote health/input/Adapter turn 前刷新 catalog 并按需重连，无 idle stop |
| `lazy-keep-alive` | 缺 metadata 时 discovery，否则首次使用才连；连后常驻，按 keep-alive 刷新 |

Eager/keep-alive 也支持 extension-load 初始化（供不发 `session_start` 的 SDK host）；session runtime 创建后取代 load-time runtime。

Remote keep-alive 的 `tools/list` 是无 `list_changed` 或通知丢失时的 authoritative fallback。每个 `tools/list`/ping 上限 5 秒，并发最多 10 servers；瞬时失败 bounded backoff，成功更新 metadata，不必重连；证实 HTTP session expired 才重连并重装 handlers。除 freezeDirectTools 外更新 direct registration。

Idle 以最近一次完成 activity 起算，每 30 秒顺序检查，所以 timeout 是最短间隔不是精确 deadline。运行/审批中的 tool、开放 UI（每 10 秒 heartbeat）、URL request 的接收与完成计入活动；Tasks 保持其连接。`idleTimeout: 0` 和 keep-alive 模式忽略 idle timer。Local stdio 会退出；HTTP/mux 只断开 client。

Startup discovery 缺 metadata（new/config changed/corrupt/TTL）时最多同时 10 个；普通 lazy 取到 tools 就关闭，批量保存一次 cache。`lazy-keep-alive`、idleTimeout 0 和 needs-auth 不按此立即关闭。Private/sign-in-scoped cache 的 lazy server 不在 startup discovery。Executor catalog 未缓存时有额外发现，见[Executor](prompts-and-ui.md#executor-app-tools)。

Lazy discovery failed/needs-auth 每个 defining config 只试一次，之后需 command/args/env/URL 等身份变化、cache 缺失/损坏或成功连接才恢复；lifecycle/idleTimeout/requestTimeout/debug 不改变该身份。瞬时 HTTP outage 下一 session 重试；eager/keep-alive 每次启动都连。

Metadata 同一文件版本复用解析；未变 canonical bytes 不写。读失败不能以空 cache 覆盖已有数据。TTL 和 runtime catalog 的保留规则见[工具](tools.md#direct-tools)。

## Settings 全表

`settings` 与 `mcpServers`、`scriptTools` 同层，放 shared MCP 或 Adapter config，不放 Pi `settings.json`（`defaultTools` 除外）。

| Key | 合同与默认值 |
|---|---|
| `toolPrefix` | `server` 默认，或 `short`（去 `-mcp`）、`none`、`mcp`（`mcp__`）；server 可覆盖。超 64 字符截短加 8 位 hash，selector 仍可用 full name |
| `allowInstall` | `true`；false 阻止 gateway URL install |
| `allowScriptToolSave` | `true`；false 阻止保存并移除 gateway 描述中的 save action |
| `idleTimeout` | 分钟，默认 10；0 禁用 |
| `requestTimeoutMs` | 缺省/<=0 用 SDK 默认；progress 重置 tool timeout，Task 按每次 request 计 |
| `deferWithMissingMetadata` | `false`；true 推迟缺失 metadata 的初始化，代价见 lifecycle/tools |
| `showStatusIcon` | `true`；false 只显示普通 `MCP:` 文本 |
| `mcpFooterStatus` | `full` 默认、`compact` 或 `off`；status 命令仍可用 |
| `toolResultRendering` | `compact` 默认或 `boxed` |
| `collapsedResultLines` | 1/2/3；compact 默认 1、boxed 默认 3 |
| `notifyOnStartupConnect` | `true`；false 仅隐藏例行成功通知，不隐藏错误/auth warnings |
| `hostConfigDiscovery` | `off` 默认、`prompt`、`on` |
| `projectServers` | `ask` 默认或 `allow`，仅 user-global/explicit config |
| `ancestorConfigRoots` | 可信 ancestor roots，作用域限制见上文 |
| `agentPluginPaths` | 显式 Agent Plugins directories，relative 按 active cwd |
| `approveTools` | true、false、`destructive`、glob[]；server 可覆盖 |
| `oauthDir` | legacy plaintext `tokens.json` import 目录，relative 按 cwd；`MCP_OAUTH_DIR` 优先。不是持久 secure store 或 namespace |
| `oauthCredentialStore` | 缺省 OS store；显式 `encrypted-file` 需外部 `PI_MCP_ADAPTER_OAUTH_FILE_KEY` |
| `directTools` | 默认 false；true/false/`search`，server 覆盖。其他 cached tools 也注册为 deferred |
| `namespaceProxyTools` | true；false 不注册 per-server `mcp__<server>` wrapper，`mcp` 和 direct 不变，`mcp:<server>` 等 wrapper reference 不再解析；reload 生效 |
| `strictDirectToolArguments` | false；true 恢复 schema-declared object/array 的一层 JSON string 后验证 |
| `directToolResultDetails` | `lean` 默认或 `bounded` guarded raw details |
| `warnOnLargeDirectTools` | true；75 个以上 direct tool advisory，可关闭但不限制注册 |
| `freezeDirectTools` | false；true 初次 sync 后冻结注册 surface，proxy/cache 仍刷新 |
| `exposeResources` | true；server 可覆盖 |
| `semanticSearch` | false 关闭，或 `{allowedServers,model,candidateLimit,minProbability}`；有明确 model 或 Pi 默认 classifier 凭据时启用，未限制时所有 enabled server eligible。只 semantic request 外发 metadata |
| `extraction` | 默认关闭；`allowedServers` 必填，`model` 可选 Cloudflare route；允许后才出现 extract 参数 |
| `disableProxyTool` | direct surface 从 cache 全部可用后隐藏 mcp；存在 search mode 时忽略 |
| `autoAuth` | false；true 在 connect/tool needs-auth 时认证并重试一次 |
| `sampling` | 有 approval UI 时默认 true；按 modelPreferences.hints 再回退当前/default model |
| `samplingAutoApprove` | false；无 UI sampling 必须显式 true |
| `elicitation` | 有 dialog UI 默认 true |
| `outputGuard` | true 默认、false 或 `{maxBytes,maxLines,detailsMaxBytes}` |
| `trace` | 默认关闭；`{enabled:true,file,maxBytes,maxEvents}`，默认 session `.pi/mcp-traces/`、262144 bytes/10000 events；只 metadata，不存 payload/prompt/args/result/auth/URL |

Per-server `idleTimeout/requestTimeoutMs/approveTools/exposeResources` 覆盖 global，debug stderr 与 trace 无关。旧 `mcpScript` settings 或 `settings.jev` 仍可读配置，但提示文件和需移除/替换的 keys，不恢复旧实现，详见[脚本兼容](scripting.md#旧配置兼容)。

## Script tools 配置

```json
{
  "scriptTools": {
    "stale_issues": {
      "description": "List stale repository issues",
      "file": "scripts/stale-issues.js",
      "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" } }, "required": ["repo"] },
      "declare": false
    }
  }
}
```

Key 为 lowercase letter 起始，仅 lowercase/digit/underscore，最多 48 字符，注册为 `mcp__script__<name>`。`description/file` 必填；file relative 按定义它的 config 所在目录，也支持 `~/`/absolute，每次调用读。`inputSchema` 若有须 object；省略无参数。`declare` 默认 false（deferred），true 从开始进入模型 tool list。

高优先级同名 entry 整体替代，未知 key/坏值仅跳过该项并警告，不影响其他项；占用其他工具名字时也跳过。每 session 每文件报告一次，并在 panel 显示。Project entries 需 trust/approval；执行与保存合同见[scriptTools](scripting.md#script-tools)。
