# 使用时顺手回归

这些是可复现步骤与预期，不是测试报告。只用临时 HOME/agent/cwd/session、fake/local provider 和自己控制的 loopback MCP fixture；不要拿真实用户凭据、真实 provider 账单或生产破坏性 tool 做回归。跨插件场景放根 integration。

## 配置与 cold startup

| Case | 操作 | 预期 |
|---|---|---|
| 空配置 | 新 process 加载 compiled entry，运行 mcp status | 可用，无 semantic/Apps/panel/setup/OAuth implementation 提前加载；不碰真实目录 |
| Pi 目录 override | 在临时 Pi runtime directory 放不同 config/cache，doctor/session 各发现一次 | 只用实际公开发现的目录，不按另一个 shell pi 版本读旧路径 |
| Claude/Codex override | 临时 CLAUDE_CONFIG_DIR/CODEX_HOME 分别放 source，setup/import | 只发现 override 来源，展示路径与冲突；不写外部 host file |
| Warm cache | 连 fixture 获取 metadata，新 process 只 search/describe | valid cache 可离线使用；同文件版本不反复 parse，内容没变不重写 |
| 首次 missing cache | 移除临时 cache，新 process | 默认 discovery 会连接；lazy 获取 metadata 后断开，不能期待绝不联网 |
| Defer missing metadata | 缺 cache + deferWithMissingMetadata true | gateway 可用，缺 metadata 的 tools/prompts/resources 暂缺；首个 MCP operation 才加载 |
| Cache read failure | 测试侧制造 unreadable/read failure，再操作其他 server | 保留原文件，不用空内容覆盖；错误可见 |
| Trust | project `.mcp.json` 改 command/url；含未批准 script | untrusted 不执行，trusted 再问；headless 默认跳过，project 自己不能 allow |
| 命令补全 | 空 prefix、合法部分 prefix、未知输入；disable 的 OAuth/bearer server | 只 canonical grammar/合格 runtime candidates，unknown null |

## 工具、审批与输出

1. Search→describe→call：名字 typo 得 suggestions，schema refs/constraints 完整，tool arguments 经过 host schema validation；invalid limit 不进入真实调用。
2. directTools search 模式：失败 call 不激活，成功 search/call 才 addedToolNames；authoritative empty catalog 清掉旧 surface。当前 runtime catalog 不因另一个 session 改 shared cache 就丢失。
3. Legacy approval broker：no listener/abstain 走原 grant/config/UI fallback；deny 即使已 grant 也不执行。Host-managed no listener/abstain 必须 not_sent。Allow server 仅内存，tree/reload 后清。
4. Large text/structured/binary/image：模型收到 bounded preview/file refs，images 原 bytes；consumer 检查 omitted。Codemode nested call full result 与模型 output guard 区分。
5. Include/exclude、disabled、app-only/model-only：所有 proxy/direct/deferred/iframe 入口一致过滤/拦截。

## Models 与 scripts

- 普通 word/regex search 不请求 classifier。显式 semantic 才外发 query/tool metadata，并使用 Pi credentials；unknown model/disallowed server 报错，transient timeout 明示 fallback，不恢复旧 System One client/key。
- Extraction 未配置 allowedServers 时 gateway 无 extract。配置后只有 allowed server + explicit extract 外发；本地 capture fixture 验证 payload 只含合同所述 text/notes，不含 image/binary bytes。Skipped/error 仍有原工具结果，不把 background Task 当已提取。
- 开 Pi codemode 后 searchTools/describeTool/CallToolResult 工作；scriptTools input schema、missing/empty/>1 MiB、nested script、project approval 均验证。保存默认不写，decline/changed-after-review 不写，write failure rollback。

## OAuth 与 durable mailbox

- 用本地 OAuth fixture 完成 code/state，错 state/URL 不接受；logout 后旧 in-flight auth 不复活 credentials。生产 fake-store env 不应改变 backend，测试替身由测试侧注入。
- 已有 Adapter credentials 可用；仅有 native Pi credential fixture 时不读/导入/删除它，应显示需重新 OAuth。Public provider-token route 仍按 origin 获取 Pi token。
- Auth success 等待投影时改当前 URL、禁用 server、撤销 project approval、删除/改 secure entry：live read-only guard 拦住旧 success，不 refresh/import/compact/write/delete。普通 token cache 的存在不能让检查误通过。
- UI 同文字点两次有两个 ID；同 ID/bytes retry 只有一次 acceptance，改 payload/乱 sequence HTTP 409。Put fail 返回 failed ACK，保留原 intent，显式 Retry 才继续；success ACK 必须晚于 durable put。
- UI text/image payload、OAuth carrier、Task terminal payload 在异步前冻结；tree 去 sibling 时 hold，回 exact leaf 才能 retry。Session replacement 拒绝旧 owner，accepted mail 不被 source close 删除。
- Task 用 modern fixture：handle 后 agent 可继续，完成/失败/cancel/unknown 经同 mailbox，无独立 native wake；code/UI/headless 等待。Reconnect 继续 polling不 cancel，resume 仅原 session，fork 不继承，stop/logout cooperative cancel。Accepted terminal result 恢复不重跑原 tool。

## 根 integration 的组合场景

Fresh stock Pi + Inject library + CC/SDK fixtures 组合检查：两种 load order、未安装可选 renderer、image bytes、session replacement、disabled source recovery、native append 后 wake 前 crash、exact proof 与 lost ACK。包内 mocks 或 public-export import 不替代这些组合场景；未运行不能记为通过。
