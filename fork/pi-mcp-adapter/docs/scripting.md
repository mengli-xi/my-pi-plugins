# 脚本、classifier 与 extraction

三种不同操作：semantic search 只发送工具 metadata 排名；extraction 经 opt-in 发送工具结果给 Cloudflare；codemode 用 Pi sandbox 组合工具。不要把它们都当作本地过滤。

## 语义搜索

普通 `mcp({search:"calendar"})` 在本地按词匹配，不外发查询。显式 `searchMode:"semantic"` 才通过 **Pi classifier/model registry 和 Pi 登录**排名，绝不执行工具：

```js
mcp({ search: "plan my week", searchMode: "semantic" })
```

没有显式 model 时，按 Pi 有 credential 的首项选用：

1. `typesafe/jev-latest`（Pi 的 TYPESAFE_API_KEY）
2. `openrouter/typesafe/jev-1.13`（Pi `/login` 或 OPENROUTER_API_KEY）
3. `cloudflare-workers-ai/typesafe/jev`（Pi Cloudflare credentials）
4. `opencode/jev-1.13`（Pi OPENCODE_API_KEY）
5. `vercel-ai-gateway/typesafe-ai/jev`（Pi AI_GATEWAY_API_KEY）

可设 `settings.semanticSearch.model:"provider/id"` 为 Pi model list 中 classifier，例如 `cloudflare-workers-ai/@cf/cloudflare/clef`，也可以 Pi models.json 配置的 local classifier。显式 model 不预检 credential，因为 local server 可能无需凭据；最终由 Pi 决定可用性。Adapter 不自行读这些 provider keys。

**外发内容**：query、server names、normalized/original tool names、tool paths、descriptions，经 Pi 发到所选 provider，不发 tool results。工具过多且跨 server 时两次调用：先发 query/server/每 server 最多 40 个 tool names 选 server，再优先排名这些 server 的 tools。需自行审查 provider privacy/retention。

默认 eligible 为全部 enabled servers；`/mcp-adapter semantic setup` 展示选定 model，选择可外发 server，写 project allowedServers，移除同文件旧 jev 设置并 reload。`semanticSearch:false` 关闭。`candidateLimit` 2–127，默认 127；`minProbability` 默认 0.2。allowedServers 仅限制 Adapter 发起的 semantic request，不管 codemode 自己的 models.classify。

Regex 不可与 semantic 同用。Timeout 5 秒/rate-limit/service down 会回退 word search 并标记 fallback；missing credential/unknown model/disallowed server/invalid response 返回可修复错误，不展示 provider 原始 error text。无匹配时明确说明，details 标识 provider/model。至少 top score 四分之一的 tools 展示 parameter shape，其余一行描述，describe 看全文。没有 Pi classifier API 的 host 只报告不支持，词法 search 仍可用。

不在 active 文档引用旧 catalog 样本的排名或延时作为 Pi 1.5.0 测量。

## Extraction：从结果取 typed values

默认关闭，须明确许可 server：

```json
{ "settings": { "extraction": { "allowedServers": ["orders"] } } }
```

开启后 gateway 才出现 `extract` 参数，search 标 `(extract allowed)`；只在调用明确请求时外发：

```js
mcp({ tool: "orders_get_order", args: { id: "B-1001" }, extract: { total: "number", due: { type: "date", description: "Delivery date" } } })
```

**许可意味着允许该工具结果发给 Cloudflare Clairic**：包含 tool text blocks、embedded resource text、structuredContent JSON，最多 100 KiB；对 >16 KiB 结果或 codemode，structuredContent 受 appendStructuredContent false 控制。不发送 image/binary bytes，但这些大结果/codemode 中 binary 可能以 Adapter short note（URI、MIME、local saved path）进入文本。非 allowed server 不发。参见 [Cloudflare terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)。

Credential 由 Pi 管理，不另存 Adapter key：

| Model | Pi 凭据 |
|---|---|
| `cloudflare-workers-ai/clairic` | Cloudflare login 或 CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID |
| `cloudflare-ai-gateway/clairic` | 上述再加 CLOUDFLARE_GATEWAY_ID，使用 gateway logging/cache/rate limits |

省略 model 先选 Pi 有凭据的 Workers AI，再 gateway。不能把 test-server 覆盖当 live AI Gateway 验证。

每次 1–16 fields；值可为 type string 或 `{type,description?,unit?,decimals?}`。Unit 用于 number/duration；decimals 0–6 用于 number/duration/list.number。

| Type | 返回 |
|---|---|
| text | string |
| number/integer | number |
| date/time/datetime | ISO-like `2026-11-02` / `14:30` / `2026-11-02T14:30` |
| duration、duration.minutes/seconds/hours/days/weeks/months/years | 对应单位 number |
| list/list.number/list.date | string/number/date array |

返回一行 JSON，values 总有全部字段，缺失为 null；confidence <0.80 时 withheld 为 null，uncertain 存 guess/confidence；truncated 表示输入超 100 KiB 或模型截断。完整原始结果存 fullResult 文件；存储失败 fullResult null，并附普通完整 guarded result。无效日期/时间算 invalid response。

```json
{"values":{"total":42.1,"due":null},"uncertain":{},"fullResult":"/tmp/pi-mcp-output-example/output.txt"}
```

跳过时仍返回普通工具结果和说明，details.extraction 包含 code：server_not_allowed、tool_error、background_task、no_text、no_source；call_failed 不再加行，保留原错误。请求失败以 `Extraction failed (<code>): <message>` 返回，code 包括 no_credentials/authentication_failed/payment_required/rate_limited/timeout/service_unavailable/invalid_response，不显示 Cloudflare 原始 error。Timeout 5 秒；不承诺实际耗时。只适用 MCP tools，不适用 scriptTools，后台 Task 不提取。

Codemode 可 `JSON.parse(await tools.mcp({...extract...}))` 读取 values；要注意此 gateway 输出是 extraction JSON，不是普通 direct tool 的 CallToolResult。

## Pi codemode

`mcpScript` 已删除，脚本只使用 Pi `codemode`。Adapter 不自动开启它，需在 Pi settings 的 defaultTools 加入：

```json
{ "defaultTools": ["+codemode"] }
```

临时用 `pi --tools +codemode`。单次 search/describe/status/auth/call 优先 gateway，循环/filter/chain/fan-out 可写脚本。Pi `codemode` 也能访问其他 Pi tools，不是 MCP-only sandbox。

Cached tools 可作为 `tools.mcp__<server>__<tool>(args)`，direct/search-mode 保留自己的 registered name。非法 JS identifier 归一化，完整名字规则见[工具](tools.md#codemode-与-tool_search)。它们不自动列在 codemode description 中，用 searchTools、describeTool、describeNamespace、ALL_TOOLS：

```js
const found = await searchTools("search issues", { namespace: "mcp__github" });
if (!found.some(t => t.name === "mcp__github__search_issues")) return found;
const result = await tools.mcp__github__search_issues({ query: "is:open label:bug" });
if (result.isError) return result.content;
return result.structuredContent ?? JSON.parse(result.content[0].text);
```

Direct/deferred call 返回 content/structuredContent/isError，不再是旧 `{ok,data}`。Server/Adapter deny 通常 isError，Pi 在执行前 hook 拦截则 reject Error；Promise.allSettled 可保留其他调用结果。Script 接收的 nested result 不走 Adapter text guard，Pi 对脚本向模型返回值默认 max_output_tokens 10000，超出 spill file。

每次 nested call 仍过 Pi tool_call/tool_result 与 Adapter approveTools/broker，call 的 parent 是 codemode。Server 未连先连；Pi 1.2+ 可先发现尚未注册的 server。QuickJS 本身无 filesystem/network/timer/Node，只能经 tools 外联。`models.classify()`、`models.generateImages()` 使用 session 的 Pi credentials、计费与权限，不受 Adapter semantic allowedServers 约束。Pi 自身[脚本 globals 与 limits](https://pi.dev/docs/latest/codemode)适用。

## Script tools

重复流程可存为 named tool，模型无需重写脚本。字段完整定义在[配置](configuration.md#script-tools-配置)，运行无需 model-facing codemode 已开启；仍需要 Pi 的 codemode API。

```json
{ "scriptTools": { "stale_issues": { "description": "Find stale repository issues", "file": "scripts/stale-issues.js", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "days": { "type": "number" } }, "required": ["repo", "days"] } } } }
```

脚本每次调用读取，缺失/不可读/空/>1 MiB 拒绝。Relative file 按 config directory，不按 cwd。Args 先由 Pi 按 schema 验证，以 input 提供；无 schema 时 input 为 {}。返回值走模型 output guard。

```js
const since = new Date(Date.now() - input.days * 86_400_000).toISOString().slice(0, 10);
const result = await tools.mcp__github__search_issues({ query: `repo:${input.repo} is:issue is:open updated:<${since}` });
if (result.isError) return result.content;
return result.structuredContent ?? JSON.parse(result.content[0].text);
```

Adapter 在开头注入 input 一行（保留 `// @options:` 第一行），错误 line number 比文件多一；Pi codemode.mode/inlineBudget 不改变 scriptTool。模型调用 `mcp__script__<name>`；默认 deferred，word/regex/tool_search/searchTools 可找到，semantic 只查 MCP tools。declare true 才主动声明。Gateway 同名优先 script，结果提示如何用 server selector 调 MCP。同名 server `script` 与 scriptTools 共用 namespace，不互相剥夺调用。

MCP_DIRECT_TOOLS=__none__ 不注册 scriptTool，但 gateway 仍可找/执行。任何 script（含 codemode）不能嵌套执行 scriptTool，报 nested_script_tool，须直接调用。每个内部 MCP call 是 nested Pi call，审批一次；approveTools 匹配内部 MCP tool，不匹配 scriptTool 外壳。Gateway 自行执行 script、禁用 registration 或 freeze surface 的 fallback 下，内部结果可能已经 output-guard 截断。

Project script 需 Pi trust 和逐项 approval；默认 Don't allow，headless 跳过，除非 user-global projectServers allow 或 process flag。Approval 绑定 entry/path，**不绑定文件内容**，文件后续改动不再问；worktree relative path 不同各问一次。未批准 project entry 与 global 同名时两项都不加载。错误/冲突每 session 一次 warning，panel 可查。

Runtime errors 包括 script_file_missing/unreadable/empty/too_large、nested_script_tool、codemode_unavailable；经 gateway 被 Pi pre-call block 则 nested_call_failed。脚本自己 throw 使用 codemode 原始错误输出。

### 保存脚本

`mcp({action:"save-script",args:{name,description,code,inputSchema}})`，target global 默认或 project，可在 args 或 top-level；拒绝 declare/其他未知 args keys。

两步审批：先展示 tool/file/config、新建或替换、config/script diff、覆盖其他来源的提示、注释/格式将被重写的提示；默认 Don't save。每份 diff 最多 60 行/8 KB、上下文 3 行，过大提示阅读 editor。选择 Review the script 打开完整 editor，可改，实际保存 editor 返回内容并告知模型；Esc 不写。

Global 写 `<Pi agent dir>/mcp-scripts/<name>.js` 与 mcp-adapter.json；有 --mcp-config 时写所选文件及其旁 scripts folder。Project 写 `.pi/mcp-scripts` 与 override。Entry file 为相对 mcp-scripts/name.js，symlink folder 会额外展示实际 target。永不自动 declare；config write 失败 rollback 新 script 或恢复旧 script。

批准后如 config/script version 已变化，拒绝写入。成功当前 session 可用，freeze 后需 reload；registration refresh 失败仍报告文件保存成功但需 reload。Project save 同时记录 approval，但不覆盖以后 script contents 变化。

仅 interactive terminal，不能 print/JSON/RPC/subagent/嵌套 tool 内调用。Project 需 trust，exclusive mode 拒绝 project save；占名、project 同名覆盖 global save 等也拒绝。Unreadable config/non-regular path/过大旧文件/非 folder mcp-scripts/write failure 为 script_save_failed；declined/headless/name_unavailable 等为普通拒绝结果。allowScriptToolSave false 全禁并从 gateway description 删除 action。

## 旧配置兼容

`mcpScript` 与其 MCP-only child recipe 已删除。旧 settings 只保留加载与带文件名的提示，不加载旧 executor；改用 searchTools/describeTool/tools 名字、CallToolResult 和 models.classify。Child codemode 可访问其他 session tools，因此没有原来“仅允许 mcpScript”的等价限制。

`settings.jev` 改为 semanticSearch：allowedServers 原样移，model 改 provider/id；semanticCandidateLimit → candidateLimit，semanticMinProbability → minProbability；旧 requestTimeoutMs/maxRetries/maxStateBytes/maxQuestionsPerRequest 删除。**settings.jev:false 不再关闭语义搜索**，须 semanticSearch false。旧 `/mcp-adapter jev setup` 改为 semantic setup。

`pi-mcp-adapter key`、SYSTEMONE_ENDPOINT/SYSTEMONE_API_KEY 和 Adapter 独立 Jev key/client 不存在；旧 Jev* public type exports 与 @typesafe-ai/sdk dependency 不再提供。Pi 负责读取 provider env/login。旧存于 OS service `pi-mcp-adapter.service-key` 的 System One key 不再使用，可由用户自行在 store 删除，不自动清理 native credentials。

McpSettings 的 scriptMode/scriptSkill，以及旧 jev scriptEvaluation/maxEvaluationsPerScript/maxEvaluationBytesPerScript/maxEvaluationTokensPerScript 已移除；不再提供 jev.evaluate、JevBudget 或 budget_exhausted，旧 bundled mcp-scripting skill/quickjs-wasi executor 不存在。配置提示不等于旧 API 仍可用。
