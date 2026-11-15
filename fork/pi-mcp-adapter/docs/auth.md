# 认证

HTTP OAuth 使用官方 MCP SDK 的 OAuth/PKCE，实现 discovery、registration、callback 和 refresh。静态 header/bearer/secret command 见后半。URL、issuer、secret scope 与 store 不可用时的 fail-closed 边界都不能因使用方便而绕过。

## OAuth 配置

最小配置只需 `url`，HTTP 自动探测 OAuth；`auth:"oauth"` 强制，`auth:false` 关闭：

```json
{ "mcpServers": { "docs": { "url": "https://api.example.com/mcp" } } }
```

Discovery 支持 RFC 9728 protected-resource metadata 和 401 `WWW-Authenticate` 的 `resource_metadata`。没有显式 clientId 时，server 支持 registration 则默认 DCR（RFC 7591）。Adapter 不默认托管 CIMD 文档。

| `oauth` 字段 | 合同 |
|---|---|
| `grantType` | authorization_code 默认或 client_credentials |
| `clientId/clientSecret` | 预注册 client；secret 支持 `!command`。显式 ID 高于 CIMD |
| `clientMetadataUrl` | 显式 public HTTPS、非根 path 的 operator-hosted CIMD；server 宣告 `client_id_metadata_document_supported:true` 才作 client_id，其他情况 DCR fallback；配 secret 但无显式 ID 拒绝 |
| `scope` | 请求 scopes |
| `authorizationParams` | 如 `{access_type:"offline",prompt:"consent"}`；禁止覆盖 client_id/redirect_uri/scope/state/code_challenge/response_type/resource 等 flow-owned fields |
| `redirectUri` | 浏览器回调，loopback http exact port 或 `{port}`；非 loopback https 用手动完成 |
| `clientName/clientUri/logoUri` | DCR metadata；clientName 默认 Pi Coding Agent，clientUri 按 host manifest，不猜 rebranded host URL；logoUri 是 absolute http(s) URL |
| `authServerMetadataUrl` | authoritative HTTPS OAuth/OIDC document，绕过不可用的 protected-resource discovery，仍校验 issuer |
| `skipIssuerMetadataValidation` | 默认 false；true 只作已知错配 server 的临时 workaround，会弱化 mix-up protection |

CIMD 必须公开可 fetch，metadata 与当前 redirect_uris/grant_types/response_types/token_endpoint_auth_method 一致，由 operator 维护。Default URL-only 仍走 DCR。

动态 fallback client 默认在 auth 开始时 lazy bind `127.0.0.1` 的 OS-assigned port。`redirectUri` 可固定 `http://localhost:3118/callback` 等 provider 要求的 callback，也可 `http://localhost:{port}/callback`；loopback host 只允许 localhost/127.0.0.1/[::1]，explicit port 精确 bind，`{port}` 代入实际端口。

Pre-registered client 未设 redirectUri 时精确使用 `MCP_OAUTH_CALLBACK_PORT`，默认 19876/127.0.0.1/callback。Callback path 与配置一致，验证 state，处理 code/state/error 并显示 success/error page，pending authorization 5 分钟超时。

DCR 注册保存 client 信息及 server 返回的 redirect URIs；新 browser flow 若有 tokens 的 cached dynamic client 不含当前 redirect URI（或缺失），重新注册；普通 refresh 不做该 redirect check，已有 refresh grant 可继续用。Authorization-code flow 用 S256 PKCE 和加密随机 state；client_credentials 不用 PKCE/browser/callback。

### Client credentials

```json
{ "mcpServers": { "service": { "url": "https://api.example.com/mcp", "auth": "oauth", "oauth": { "grantType": "client_credentials", "clientId": "service-client", "clientSecret": "${SERVICE_CLIENT_SECRET}", "scope": "read" } } } }
```

不打开浏览器，redirectUri 忽略；clientName/clientUri 仍用于 DCR metadata。

## 发起、完成与退出

`/mcp-auth <server>` 默认由用户主动发起；无参数仅 TUI picker。Panel Ctrl+A 或 needs-auth server Enter 也可发起。开启 `settings.autoAuth:true` 后 proxy/direct connect/tool needs-auth 会认证，再重试原操作一次。回调服务只在需要时启动。

Adapter **不读、导入或删除 Pi 内建 MCP 的私有 credentials**，没有 startup import prompt 或 Ctrl+P。Adapter 已持有的 URL-bound credentials 不受影响；过去只依赖 native import 的用户需重新 `/mcp-auth <server>`。这不影响下面通过 Pi 公开 model registry 取得 provider token。

完成后 SDK 附 access token 并自动 refresh；无效 credentials 显示 needs-auth。`/mcp-adapter logout <server>` 清理 Adapter credentials 并断开。在同一 process 内 logout 是 linearizable boundary：此前开始的 OAuth 不得在清理后复活 credentials，之后的新 OAuth 等 logout 完成；公开显式 token update 保留 last-writer 语义。不同 Pi processes 不协调，仍可能 race。

### Remote/headless 认证

远端 TUI 显示完整 authorization URL，在本地浏览器批准后，如 loopback 不能返回远端，复制地址栏的完整 callback URL，在同一 Pi session 粘贴完成；直接可达时自动结束等待。

非交互客户端：

```js
mcp({ action: "auth-start", server: "docs" })
mcp({ action: "auth-complete", server: "docs", args: { redirectUrl: "http://127.0.0.1:19876/callback?code=...&state=..." } })
```

也兼容 `args:{code:"..."}` 和 JSON-string args。完整 URL 校验保存的 state；raw code 用于直接展示 code 的 provider。Authorization URLs/codes 是敏感数据。Loopback auth-start 尝试打开 URL 并观察 callback，后台结果经[durable mailbox](mailbox.md)发送 `mcp-oauth-status`；凭据成功不代表通知投递成功，通知失败单独报告。

OAuth success 的投影 guard 使用**当前 effective server URL**和实时 secure-store 的只读状态，而不是启动时 URL 或 process token cache；不触发 refresh/import/compact/write/delete。配置变更、logout/外部删除、server disabled/unapproved 或 owner retired 都不能被旧 success 通知绕过。恢复只重投已接受的 carrier，不重新认证。

## Secure token storage

默认由 `@napi-rs/keyring` 写 macOS Keychain、Windows Credential Manager、Linux Secret Service/libsecret，按 configured server name 存 tokens、dynamic client 信息、历史 verifier/state 字段和 serverUrl binding；URL 改变不能复用旧 credentials。

Windows 超 1000 UTF-16 code units 用 manifest + chunks；macOS/Linux 普通 entry 为一个 item，真实 native size error 直接上报。旧 chunk entry 的普通读取可校验并 compact 成单 item 后清旧 chunks；**status inspection 只读，不 compact**。生产运行不接受 fake-keyring/memory-test-store 开关；替身只能在测试侧注入。

OS store 不可用 fail closed，不 fallback plaintext。Linux 上 `@napi-rs/keyring` 找不到 Secret Service 时会自动改用内核 keyutils keyring：凭据只在内存里，重启后需重新认证；要持久保存，需提供已解锁的 Secret Service。Windows OpenSSH network logon 可能报 `ERROR_NO_SUCH_LOGON_SESSION` (1312)。Linux revoked inherited keyring 可在 native operation 的 KeyRevoked 时 best-effort retry 一次 `keyctl session - <runtime> <packaged helper>`（OAuth recovery helper 使用 node），10 秒 timeout；须 PATH 有 keyctl/所需 runtime 且新 session store 可用。缺失/locked/其他错误仍 fail closed；`PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY=1` 可禁用 recovery。此机制不生成替代 plaintext store。

### 显式 encrypted-file

设置 `settings.oauthCredentialStore:"encrypted-file"`，从外部 secret mechanism 注入 `PI_MCP_ADAPTER_OAUTH_FILE_KEY`，必须是 32 random bytes 的 canonical base64：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

key 不能写配置或与 ciphertext 同放。AES-256-GCM versioned envelope 在 `<Pi agent dir>/mcp-oauth-encrypted/sha256-<server-hash>/credentials.json`；URL/secrets 只在 ciphertext，account-bound authenticated data 防跨 account 搬移。采用同目录 atomic replacement 和可用平台的 private modes，POSIX 读取检查 modes，但不把它冒充 Windows ACL；保密边界是外部 key 的 encryption。

此 backend 不 fallback OS store、不读 oauthDir/MCP_OAUTH_DIR、不 import legacy plaintext，选择后需重新认证。Key 丢失/轮换时旧 envelope 不可读，移除旧 envelope 后重新认证；Adapter 不代管 key。

### 缓存、实时检查与 legacy plaintext

普通 SDK 每个请求都会取 token，所以完整 entry 在 process 内缓存 present/absent；auth/refresh/logout 即时更新，避免逐请求打 OS store。Panel/status 与 mailbox success guard 刻意绕过此 cache，只读实时 store。

其他 process 改/删 credentials 不会即时更新普通 request cache；该 needs-auth episode 第一次 credential-backed failure 会清 cache，下次读 reload；restart 也清除。`PI_MCP_ADAPTER_DISABLE_AUTH_CACHE=1` 可恢复逐请求读取。

旧 `tokens.json` 位于 `<Pi agent dir>/mcp-oauth/sha256-<server-hash>/`，或 oauthDir/MCP_OAUTH_DIR。默认 OS backend 的普通首次读可单向 import 合法 legacy entry，成功后删除该 plaintext；encrypted-file 留它不动。这些只是 legacy import location，不是隔离 namespace。Status/mailbox 只读重检不执行这种迁移。

## Pi provider tokens

```json
{ "mcpServers": { "docs": { "url": "https://mcp.example.com/mcp", "auth": { "provider": "example-provider" } } } }
```

每次 request 通过 Pi 公开 model registry 取 `/login` token，发送 Authorization Bearer，不由 Adapter 存/cache/展示。只发送到配置 URL 的 origin（scheme/host/port），带 token 拒绝 redirects。URL 须 HTTPS 或 loopback HTTP。仅 user-global，project 定义/override 跳过并警告，Pi MCP config 同规则。

无 token 时不发 request，needs-auth，需 `/login <provider>` 后 reconnect；不启动 MCP OAuth。无 model registry 的独立 SDK/doctor 不能访问 Pi token，报告 limitation/needs-auth。这不是 native MCP sign-in import。

## Headers、bearer 与 secret commands

显式 `auth:"oauth"` 的 configured headers 可随 native metadata discovery（含 authServerMetadataUrl）、DCR、exchange/refresh 发送，但**只限 MCP URL origin**。其他 OAuth origins 不带 service headers，SDK OAuth Authorization/content types 优先。带 service headers 的 fetch 拒绝所有 redirects，包括 same-origin；browser navigation/callback 不带它们。缺/空 credential fail closed。

`requestHeadersCommand` 是 transport `requestFetch` signer，不是通用 OAuth hook。Connection 中 MCP 与 SDK 经该 fetch 的 discovery/DCR/exchange/client_credentials/refresh 都会调用，包括 cross-origin OAuth；command headers **不自动 origin-scoped**，helper 收到 exact method/URL/body，必须自行决定 credential scope。返回 headers 最后应用，可覆盖 SDK Authorization/content types，非有意不要碰这些名字。

Provider-owned `authFetch` metadata、standalone OAuth start/complete/refresh 不经过 signer；browser/callback 也不经过。不要据 URL 相同就假设这些路径都会签名。

`headers/bearerToken/oauth.clientSecret/stdio env` 可用前导 `!command` 动态取 secret；连接/auth 才执行，读/merge/preview/hash/render 配置不执行，preliminary challenge probe 不执行 command headers。Header commands 在实际 SDK backchannel 每 authentication leg/connection lazy resolve 一次。`!!` 是 literal leading `!`；普通/literal 值仍做 env interpolation。

Command stdin/stderr suppressed，stdout trim、上限 1 MiB，10 秒内须非空，失败停止连接/auth。Windows 优先 Git Bash（标准位置再 PATH bash.exe），否则 cmd.exe。

### 静态 bearer store

`auth:"bearer", bearerTokenStore:true` 在无显式 bearerToken/bearerTokenEnv 时读 Adapter namespace，按 name 存且绑定 resolved URL；store unavailable/malformed/URL mismatch 均不 fallback plaintext。Literal/command/env 优先，已有配置不变。

`pi-mcp-adapter token set <server>` 仅 masked terminal prompt 或 piped stdin，不接受 argv secret；Node 22.18+。Pi 内只提供 token status/remove，不提供 set，直到 host 有 masked secret input。Native Linux KeyRevoked recovery 与上文相同。

## 故障排查与安全边界

- No OAuth tokens：`/mcp-auth <server>`。
- Discovery/DCR unsupported 或 HTTP 403：向 provider 获取 pre-registered clientId；必要时设置可信 authoritative metadata URL，不关闭 issuer check 来掩盖未知 server。
- Fixed callback 占用/不匹配：按 provider 注册精确 redirectUri 或释放配置端口；dynamic fallback 自取 OS port，不依赖默认固定端口空闲。
- Browser 未打开/remote：复制显示的 URL，保留同 session 手动 callback 完成。
- 不把所有 flows 都称 PKCE：PKCE/state 保护 authorization_code，client_credentials 无 browser code。
- Credential URL binding、issuer validation 与 store failure 都保留错误上下文；不能把 upstream main 的 Unreleased security 修复推断成本包 7.0.1 已覆盖。

公开 OAuth helpers 及 refresh 配置边界见[扩展 API](extension-api.md#sdk-配置)。规范参考：[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)、[PKCE](https://datatracker.ietf.org/doc/html/rfc7636)、[DCR](https://datatracker.ietf.org/doc/html/rfc7591)、[CIMD](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)。
