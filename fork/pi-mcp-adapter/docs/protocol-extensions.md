# Protocol extensions

可信 Pi extension 可以借 Adapter 现有配置/auth/连接实现额外 MCP capability；先声明方法，再显式执行。Registration 不连接、不订阅。普通 tools/call 仍用[工具 API 与审批](tools.md)。

```ts
import { registerMcpProtocol } from "pi-mcp-adapter";
const protocol = registerMcpProtocol(pi, {
  namespace: "example",
  requests: ["example/list"],
  streams: ["example/stream"],
  notifications: ["notifications/example/active", "notifications/example/item", "notifications/example/list_changed"],
});
const session = await protocol.connect("configured-server");
const watch = session.watchNotifications(["notifications/example/list_changed"], () => {
  // Invalidate the consumer's catalog, then explicitly re-fetch.
});
const catalog = await session.request("example/list", {});
// Validate capability-specific results before use.
const stream = session.openStream("example/stream", { name: "chosen-item" }, (method, params) => {
  // Validate and render this capability's notifications.
});
await stream.sent; // transmission, not acknowledgement
const end = await stream.closed; // cancelled, ended, error, disconnected
// Or: await stream.cancel();
watch.close();
session.close();
protocol.dispose();
```

## 注册与权限

Adapter 已加载后注册（如首次使用）；hook 缺失抛 actionable error，调用方必须处理。每 Adapter namespace 唯一，declarations/namespace 复制。Request/stream 必须在声明 namespace，notification 必须 `notifications/<namespace>/...`；tools/resources/subscriptions 等 core namespaces 保留。

API 不泄露 SDK client/transport/arbitrary send/handler replacement。Request 仅声明 methods，返回普通 SDK result；stream 仅声明 methods，通知只按 `params._meta["io.modelcontextprotocol/subscriptionId"]` correlation 路由。Params 不能覆盖 reserved _meta；其他 traffic 继续给 SDK。

需要 active Pi session、effective enabled server，连接经过正常 project trust/server approval/lazy/runtime owner。它是可信已安装代码的 API，不是 sandbox，不能限制同 process 任意 extension code；consumer 负责额外 capability consent、payload validation，把外部结果当不可信数据。

## 生命周期

Adapter 分配 request ID，发送 cancel，报告 remote result/error/server cancel/transport close/session replace。Consumer throw 只关自身 stream。

Request/stream/notification observer 活跃时才阻止 idle cleanup，counts 绑定 exact connection，不迁到 reconnect。Close session/dispose registration 取消其工作，不关闭共享 client。Consumer 观察 session.signal/stream.closed，断开后显式 reacquire；无自动订阅/重放。

`sent` 只证明写到 server，不证明 ACK。Activation timeout、heartbeat、cursor/replay、persistence 与 agent wake 都由 capability consumer 管理；不能由 sent 推断远端接受，也不能借 API 增设本包第二条后台 native delivery。

## Notifications 与错误

Watch 只观察声明但不属于 active extension stream 的 notification（如 catalog change），有 close 和同 stream termination reasons 的 closed promise。Params/declarations 复制，observer throw 仅关闭自身，SDK 仍收到。Stream-correlated message 不广播给 observers。Watch 被动，不发 subscribe、不建 remote channel；若 server/transport 不送，consumer 自己定期普通 request 刷 catalog。

Stream JSON-RPC error 保留 end.protocolError 的 code/message/data 和 display end.error；普通 request 保留 SDK typed rejection，不用 parse display text 分辨 auth/unsupported/transient。

## Transport 边界

适用 stdio、Streamable HTTP、legacy HTTP+SSE、Unix socket，不添加 WebSocket 或新的 server config。SDK 负责普通 request/transport/HTTP headers/OAuth/TLS/resumption；Adapter 为缺失的 generic long-lived stream primitive 在每 transport 放一个内部 router。

Streamable HTTP 用 per-request abort/stream-end callback，cancel 只关该 SSE response，不影响 sibling streams；shared-channel transports 用 notifications/cancelled。Request-stream EOF 没 final response 为 disconnected，共享连接仍 alive 则 session 可继续用。Capability cursor 与 SSE transport resumption token 是两层，不能混用。

Poll/webhook control 也是普通 declared request。Webhook receiving/signature verification/renewal/delivery selection/cursor/replay/persistence 归 consumer；Adapter 不启动 webhook server/delivery loop。定时请求遇 idle disconnect 需 reacquire，Pi session 结束必须停止 retry。

## 跨 package event

Synchronous `pi-mcp-adapter:protocol:v1`，请求 `{version:1,definition}`；Adapter 同步写 mediated handle 到 result，或写 error。两者都没有是 hook 不可用，必须降级。`registerMcpProtocol` 本身也这样实现；consumer 可以使用 structural contract，不 import 第二份 Adapter instance。新协议必须带版本，不能模仿 legacy approval event 命名。
