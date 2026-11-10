# 可选搜索 backend 合同

本页由 `pi-native-search` 定义。工具入口与数据外传说明见 [README](../README.md)，配置和 child snapshot 见[配置与运行合同](runtime-contract.md)。本协议只扩展搜索，不扩展 `web_fetch`。

## 发现与描述符

事件名：`native-search:backends-request-v1`。

每次搜索同步 emit `{ version: 1, contribute(backend) }`。集成通过 `pi.events.on()` 订阅，在回调返回前调用 `contribute()`：

```ts
const unsubscribe = pi.events.on("native-search:backends-request-v1", (request) => {
  if (request.version !== 1) return;
  request.contribute({
    version: 1,
    id: "example-search",
    label: "Example search",
    defaultProviders: ["example-provider"],
    async search({ query, ctx, signal }) {
      // 使用执行 session 的公开 context；返回已格式化的文本。
      return "formatted search results";
    },
  });
});
```

描述符字段：

| 字段 | 合同 |
| --- | --- |
| `version` | 固定为 `1` |
| `id` | 非空字符串；`native`、`ddg` 保留给路由选择 |
| `label` | 非空字符串，用于进度与状态展示 |
| `defaultProviders` | 字符串数组，元素非空；可为空数组，表示只能显式选择 |
| `search` | 接收 `{ query, ctx, signal? }` 的异步函数，必须返回字符串 |

`ctx` 是实际执行 session 的公开 `ExtensionContext`，包括其 model registry 和 cwd；不能以 Main 的 cwd 或 model 替代 child 的值。集成自行负责 provider 响应的严格校验和文本格式化，不能把畸形成功响应当成正常搜索结果。

发现期间不传配置文件、凭据、模块路径或 provider factory。该接口不是隔离层：backend 与本包同进程运行，并能使用公开 context，必须把它当作可信代码审查。私有传输、配置布局与默认 provider 映射归外部集成，本包不探测它们。

## 校验与选择

发现只接受同步贡献；回调返回后才贡献的异步响应忽略。描述符格式错误、重复 backend ID 或重复默认 provider 声明都会在执行和 DDG fallback 之前报错，不按加载顺序选赢家。同一 backend 内重复声明同一默认 provider 也属于冲突。

配置中的 `providerOverrides.<provider>.searchBackend` 按以下规则选择：

1. `"ddg"` 强制 DuckDuckGo。
2. 若有 backend 的 `id` 与配置值相同，选择它。
3. 否则若有 backend 的 `defaultProviders` 包含当前 provider，选择它。
4. 否则采用内置 provider 原生搜索；无支持或无兼容凭据时走 DuckDuckGo。

所以 `"native"` 表示“保留 provider 默认路由”，不是绕过外部集成默认映射；未知 ID 也保留默认路由。没有 responder 时公共 provider 仍可原生搜索，其他 provider（包括普通 `claude-bridge`）走 DuckDuckGo，不尝试读取其私有配置或凭据。

backend 抛错或返回非字符串会进入正常 native-to-DDG fallback。fallback 成功保留原失败提示，两边失败保留两边的错误上下文。取消会中止执行，不再启动 fallback；集成必须传递并遵守调用者的 `AbortSignal`。已发送的请求可能无法撤回，降级不保证没有额外请求或费用。

## 加载顺序与撤销

每次调用重新发现当前 responder，因此集成先加载或后加载都可用，不需要启动探测。`unsubscribe()` 撤销未来调用；已经执行的调用继续完成或遵守自身 `AbortSignal`。替换 responder 前先取消旧订阅，避免重复 ID/default-provider 冲突；旧 disposer 只能撤销自己的订阅，不能撤销替代者。

集成负责注册与释放。Search 不自动安装、import 或管理集成的私有生命周期。内置 provider 设置列表不枚举外部 provider；实际工具进度和后续状态刷新可显示外部路由。

## Main 与 SDK child

Main 默认通过自己的 `pi.events` 发现。SDK Host 若要让 child 使用 Main 的已批准集成，必须把 emitter 显式传给工具 assembly：

```ts
createSearchChildFactory(configSnapshot, { backendEvents: mainPi.events });

// 或显式安装：
installSearch(childPi, {
  child: true,
  config: configSnapshot,
  backendEvents: mainPi.events,
});
```

`backendEvents` 的类型是 `Pick<ExtensionAPI["events"], "emit">`，不是模块路径或 provider 名称。Host 须保证 emitter 绑定到所属 runtime，并在销毁该 runtime 前停止 child 工作。backend 收到的仍是执行 child 的 context，不是 Main context。

没有显式 emitter 时 child 只发现自己的 event bus，不借用进程全局集成状态。配置始终独立复制；传 emitter 不赋予 child 修改 Main 配置、命令、状态或 capability owner 的权限。
