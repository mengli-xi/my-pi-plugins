# 容量观测合同

本包拥有轮询、认证观测、响应校验、私密缓存和不可变语义快照；不拥有 `/model`、statusline、SDK 装配、工具或 provider 执行。

## 内置 adapter

- OpenAI Codex：使用 Pi 解析的 ChatGPT OAuth，请求 `GET https://chatgpt.com/backend-api/wham/usage`。按声明的时长分类窗口，不按 primary/secondary 位置猜测。
- Grok：使用 Pi 解析的 xAI 订阅 OAuth 和 Grok CLI token-auth 标记，请求 `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`。不支持 API key 账单。只有当前有效周期内缺省的 proto 标量才表示 0%。
- DeepSeek：使用 Pi 解析的 API key，请求官方 `GET https://api.deepseek.com/user/balance`。发布剩余、赠送和充值余额，不虚构 used/limit；拒绝自定义 provider origin。

环境专用 adapter 由外部扩展注册，本包不 import 它们。provider ID 为小写公开标识，匹配 `[a-z0-9][a-z0-9._-]{0,127}`，没有封闭品牌名单。

## 注册与权限

公开导出 `pi-model-capacity/adapter`（类型、解析与 HTTP helper）、`contracts`（V2 校验和频道）、`registration`（事件客户端）。

```ts
import { registerCapacityAdapter } from "pi-model-capacity/registration";
const registration = registerCapacityAdapter(pi.events, {
  provider: "example-capacity",
  intervalMs: 30_000,
  staleMs: 90_000,
  async resolveAuth(ctx, signal) {
    // 未配置时返回 undefined；异步发现须尊重 signal。
    return { apiKey: "fixture", headers: {}, fingerprint: "account-revision" };
  },
  async fetch(auth, { fetch, now, signal, ctx }) {
    return { models: { example: { loadPercent: 25, quota: { remaining: 9, limit: 10 } } } };
  },
}, error => { /* 由集成方报告准入错误 */ });
pi.on("session_shutdown", () => registration.dispose());
```

helper 先监听，再同步发送 `model-capacity:register-adapter-v1`。owner 安装监听后广播 `model-capacity:adapter-ready-v1`，载荷 `{version:1,ownerId}`，覆盖两种加载顺序与 owner 替换。缺 owner 表示尚未准入，不是假成功。handle 提供 `accepted`、`error` 和可选错误回调。

原始请求为 `{version:1,adapter,reply}`；成功回复 `{version:1,ownerId,accepted:true,release}`，失败回复 `{version:1,ownerId,accepted:false,error}`。同 owner 的重复 ready 忽略，新 owner 重新准入。未知版本、重复 provider ID（含内置 ID）拒绝，不替换、不合并。

release 幂等并绑定身份，旧 lease 不能删新注册；释放时中止请求、取消 timer、删除私密 auth/cache，再以新 revision 发布移除。晚注册加入已有全 provider watch 及该 ID 的显式 watch。最后一个 watcher 释放会撤销待完成 auth、abort fetch；迟到结果不能复活。

准入只授予容量观测。ctx 仅暴露 `getProviderAuthStatus`、`getAvailable`、`getAll`、`isUsingOAuth`、`getProviderAuth` 和只返回 base URL 的 `getProvider`，不传 complete、SDK factory、工具、session 或 UI 端口。这是同进程合作合同，不是 OS 沙箱；加载任意 JavaScript 本身不构成安全边界。

## V2 snapshot、request 与 watch

V1 的封闭 provider 集不再发布；owner 与展示方须一起升级，不静默接受或双发 V1/未知版本。

- `model-capacity:snapshot-v2`：不可变 `ModelCapacitySnapshotV2`，含 `version:2`、必填 UUID `ownerId`、owner 内单调 `revision`、可选 `sessionId` 和 `providers`。revision 只在同 owner 内比较；新 owner 重置，退役 owner 的迟到数据拒绝。
- `model-capacity:request-snapshot-v2`：同步恢复缓存。

```ts
pi.events.emit("model-capacity:request-snapshot-v2", {
  version: 2, sessionId,
  reply(snapshot, refreshReceipt) {},
});
```

加入 `refreshProviders:["example-capacity"]` 可确认刷新。回复等待请求后的一次去重 fetch；此前开始的 flight 不算。receipt 按 provider 报告 refreshed、最终 state 和可选 observation/error；未知或已移除 ID 返回 unavailable，刷新期间替换不能给新 owner 伪造成功回执。

- `model-capacity:watch-v2`：`{version:2,watcherId,action:"acquire"|"release",sessionId?,providers?}`。省略 providers 表示当前及未来全部 adapter；acquire 立即刷新，只轮询活跃 watch 并集，按 adapter 周期执行；release 只取消无人再观察的 provider。

CC 保存活跃 watch，用 ready 握手处理晚加载/替换：先同步请求 V2 cache 核实 ownerId，再重放活跃 acquire。监听就绪前的 snapshot 不提前触发重放。重复/未知 ready、退役 owner、迟到 cache/确认回复拒绝。会话替换和 dispose 释放 watch、拒绝待刷新结果。

字段与 validator 见 [src/contracts.ts](../src/contracts.ts)：状态、observed/stale 时间、可选 plan/windows、网关并发、模型负载/quota 和余额。model/quota 来源时间为 epoch 毫秒，reset 为 epoch 秒。CC 按数据形状展示，不按品牌分派；adapter 不含展示代码。

## 失败、账户与生命周期

- 短暂 fetch 失败保留上次成功数据并标 stale；缺 auth 清为 unavailable；坏数据标 error，有旧值时标 stale。
- auth fingerprint 只作私密缓存身份，不进入 snapshot；变更后先清旧账户数据再发布 refreshing，旧 auth 解析不能覆盖新结果。
- 缓存前校验并复制，snapshot 及嵌套值冻结，修改不能绕过 revision/校验。
- 每个 provider 的确认刷新和 fetch 去重。内置请求限制超时/正文大小；auth 发现也接收 abort signal，替换、最后 watch 释放、adapter 释放和 dispose 都中止它。外部 adapter 须尊重 signal、限制自己的 I/O；即使忽略 abort，generation/identity 检查也拒绝迟到结果。
- 会话切换清 watch、待处理工作及 auth/data；dispose 先发布空 snapshot，再停 timer、abort 和移除 listener。集成方也须释放注册 handle。

## `/usage` 与历史

`/usage` 刷新全部注册 adapter，按形状格式化。TUI 首帧显示 cache/loading 后刷新；失败保留 cache 并显示原因，RPC/headless 输出文本。

Codex 历史为 `<agent-dir>/codex-usage.jsonl`；只有已结算 Codex 流量或显式 `/usage` 才追加样本，selector 轮询不生成零流量历史。旧字段仍可读。agent-dir 取公开 `getAgentDir()`，不猜 HOME。

测试使用合成 adapter 和注入 HTTP fixture，不访问真实账单或凭据；环境专用解析/发现测试归外部 adapter。
