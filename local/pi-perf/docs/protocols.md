# 能力协议

入口见 [README](../README.md)。协议是同进程可选协作，不认证 producer、不授予执行或视图权限。消费者验证 version 和必要方法；缺失、未知或冲突时不采集，不能为了性能观测拦截原始输入或渲染。

## pi.perf.ui-metrics.v3

`globalThis[Symbol.for("pi.perf.ui-metrics.v3")]` 提供 `version: 3`：

- `acquire(owner, observer)` 返回幂等 disposer。observer 有 `now()`、`record(name, ms, detail?)`、`painted(at)`，可选 `terminalInput(data, at, detail?)`、`inputHandled(data, startedAt, finishedAt, detail?)`。输入文本只在同步回调内用于分类，不得持久化。
- `getStatus()` 返回 provider、enabled、subscribers 与 requestRender / doRender / handleTerminalInput 健康度和可选 detail；observer 故障以有界、无 payload 的诊断保留。
- `snapshot()` 返回 at、metrics、owners 和可选 runtime 数值快照。每个 UI 指标最近窗口 512 项。
- `reset(owner?)`：消费者不能擦除共享 provider 的样本；provider 可清空。
- provider 可选方法 `setEnabled(enabled, owner?)`、`updateRuntime(snapshot)`，不由消费方启用全局探针。

v3 wrapper 位于真实 TUI 的方法 owner 上，不 import 第二份 TUI 来猜 identity。支持多个 observer，释放 observer 不拆除稳定 wrapper。v2 marker 存在或版本冲突时 fail closed，不叠加包装；相容外部 v3 只加入已有 provider。`now`、record、painted 和两个输入 callback 分别故障隔离、逐方法停用；有故障的方法在本 observer 生命周期内不再调用。原方法返回值和原异常不变。包装代码本身（尺寸/模式 getter、输入分类、render finally 和延迟回调）也被隔离，失败保留有界诊断，不吞原始调用或覆盖原异常。

CC Style 仅订阅；没有本包时不创建第二个全局 wrapper / timer。消费约束同时见 [CC contract](../../pi-claude-style/docs/spec.md)。

## pi.perf.telemetry.v1

`globalThis[Symbol.for("pi.perf.telemetry.v1")]` 提供 `version: 1`：

- `acquireReporter(owner)` 返回 `{reporter, release()}`；reporter 提供 `configure({sampleWindow?, slowSampleMs?, logEnabled?})`、`measure(name, ms, attributes?)`、`increment(name, delta?)`、`observe(name, value, unit)`、`gauge(name, value, unit)`。
- `acquireObserver(owner, callback)` 返回幂等 disposer。
- `snapshot(owner?)`：measures、observations、counters、gauges 和 owners；`reset(owner)` 只清本 owner，`resetAll(requester)` 仅接受已知 provider。
- `setEnabled(enabled, providerOwner)` 和 `getStatus()` 归 provider 管理。默认关闭，existing reporter 无需重新获取即可随 `/perf on|off` 生效；release 后 reporter 是 no-op。

默认 sampleWindow=512（configure 限制在 16..10000）、slowSampleMs=50（1..60000）、logEnabled=false。owner 最多 80 字符、metric 160、unit 24；最多 16 个 attribute、键 64、字符串值 160，仅允许有限数值 / boolean / string，丢弃 object。只发布闭集枚举、计数和不透明 ID，不发布提示词、会话正文、工具参数/结果、路径或任意用户文本。类型与长度校验无法代替 producer 的语义隐私责任。

CC Style 和 Session Naming 都是可选 producer，独立加载和缺本包时正常工作。provider 可能晚加载，consumer 在后续观测边界重新发现，不为等 registry 阻塞操作。session lifecycle 仍走 Pi，不滥用 telemetry 作为控制总线。

## 所有权与可选宿主标记

`pi.perf.runtime-owner.v1` 是内部进程 lease，不是跨插件业务 API。接管同步退役旧 timer、histogram、observer、UI subscription，旧 release 不能释放新 owner。`pi.perf.startup-observed-frame.v1` 保留进程级冷启动完成事实，不保存 Pi context；旧 startup-first-paint.v1 仅用于 reload 时读取既有 guard。`pi.perf.package-inventory.v1` 是不含 Pi context 的内部进程缓存，按 sources/cwd 签名失效，不是跨插件控制协议。

兼容可选的 `pi.extension-module-cache-policy.v1`、`pi.session-replacement-gc-policy.v1`、`pi.session-replacement-gc-metrics.v1` 宿主标记。它们只影响健康诊断、GC 数值 timeline 和 Bun 下的单次 warning；缺标记不阻断会话，不自动安装补丁。


## 可选问卷观测

监听 `rpiv:ask-user:blocked`，并在 Pi 的工具生命周期里观察 `ask_user_question`，只用于标注问卷 Enter、关闭与恢复到工具的耗时；不导入问卷插件、不读取其存储、不控制其执行。没有对应插件/事件/工具时不产生问卷指标，其他采样和原始输入、渲染照常。
