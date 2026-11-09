# 本地维护

- 原创 package，无 upstream。
- 产出一个 Bun-bundled `dist/index.js`。修改 TypeScript 后运行 `npm run build`。保持 `@earendil-works/*` external，使 Pi 只提供一份 runtime copy；`conf` 会被 bundle，以免 sequential extension startup 时再付出一次 ESM dependency-graph import 成本。
- 在 `agent_settled` 后优先使用 Pi 公开的 `ModelRegistry.complete`，并转发真实 Pi session id 以维持 native-provider affinity。默认优先关闭 reasoning，模型不支持时使用最低可用 thinking level、128 output token、可 abort 的 15 秒 deadline；package startup 不加载 model completion code。
- 旧 CC Style config 是只读的一次性 migration source。绝不要在 CC Style 中重新为 `transcript.sessionNaming` 加入第二个 writer。
- performance data 仅作为 producer 经 `Symbol.for("pi.perf.telemetry.v1")` 发布：completion 与 total generation span，以及 lifecycle / outcome counter。由于 `pi-perf` 可能在本包之后加载，discovery 保持 lazy；aggregation、periodic sampling 与 log 仍由 provider 拥有。request deadline 是唯一 package timer。每个 request 只清自己创建的那个 timer，共享引用还指向它时才置空，和 abort
  controller 用同一个 guard。少了这层 guard，切 session 之后迟到 settle 的旧 request 会取消新 request 的 deadline。shutdown
  靠 `cancelPending` 取消当前 timer 与 abort。旧 generation 迟到失败的 catch 同样只记 `generation.stale`
- 本包只拥有自动命名与 conf 配置；手动重命名使用 Pi 内置 `/name`，不注册自己的命令。
