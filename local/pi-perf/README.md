# pi-perf

Pi 的常开低频性能监控、可选细粒度 TUI / 插件耗时探针和离线 HTML 报告。可单独加载，不依赖其他插件；CC Style、Session Naming 缺席不影响采集。

## 加载与验证

在仓库根执行 `bun install --frozen-lockfile`，然后 `pi -e "$PWD/local/pi-perf"`。无需构建，不安装或替换日常 launcher。

```sh
npm run typecheck -w pi-perf
npm test -w pi-perf
npm run check:internals -w pi-perf
npm run check:host -w pi-perf
npm run check:smoke -w pi-perf
```

当前支持版本见[根支持说明](../../README.md#支持说明)。宿主检查经根 runner 验证 CLI / SDK 版本、隔离 HOME、agent、session、XDG 与 npm 配置，只启动仓库宿主，不调用 provider；同时运行最小真实 PTY 绘制边界检查。`check:smoke` 复用这两项最小宿主检查：快速档也验证 TUI 方法和真实绘制时序，不运行完整 PTY 快照、历史或长时间性能矩阵。PTY 套件显式要求 Bun PTY，不依赖 tmux。

性能回归测试使用独立 Node 进程，测量默认直方图、真实采样和文件写入的 CPU，并加速四天采样检查稳定期内存；不是人工 TTY、真实 provider 或长时间生产运行的替代。

## 默认采样与命令

启动关键路径不运行清理或等待包名解析。只有 TUI 上下文会调度维护：延后 30 秒，之后每六小时检查；同一 profile 只有持 maintenance 锁的进程合并，退役时取消 timer 并在事务批次间停止。RPC、print、json 子进程只写数据，不调度维护。run 文件保留到日期严格早于当前日期减 7 天，之后合并为有界日汇总并删除已提交的源 run；常规 tmp 回收只打开最近 3 天的 daily 目录，合并旧日期时也清理该目录中的死进程 tmp。详情见[存储合同](docs/storage.md)。

包名解析延到下一个事件循环轮次，异步读取显式包根自己的 manifest；缓存签名包含 sources 与 cwd。相同签名的 `/new` / resume / reload 复用结果，sources 或 cwd 变化时重新解析。`session_start` 即时返回；写入队列从构造时就等待身份就绪，即使会话启动超过 60 秒，提前采集的样本也不会用空身份写盘。解析完成后补齐包名、哈希和 `packageResolveMs`；120 秒仍未就绪或解析失败则用 local 兜底并诊断，不无限等待。不把解析等待算成 ready 耗时。`/perf` 可查看这次解析耗时。

默认每 60 秒记录 RSS、heap used/total、external、区间 `process.cpuUsage()` 差值、事件循环延迟 p50/p99/max、会话条目数和可用的上下文 token 数。CPU 百分比以一个逻辑核为 100%，多核工作可超过 100%。事件循环直方图分辨率 20ms，每分钟重置，不是持续增长的窗口；输出是超出 20ms 分辨率的额外延迟（原始定时间隔减 20ms，并截到 0），不是定时间隔本身。低频与细粒度模式共用一个直方图和采样 timer，同一 tick 的内存读数共享；细粒度终端和 HTML 都标注“本分钟窗口（≤60s，采样或 reset 后重置）”，刚重置时 0ms 表示该窗口暂无延迟样本。

仅 `session_start(reason="startup")` 且当时采样开启时记录冷启动；运行中的 `/reload` 新装本包、启动时关闭后再 `/perf on`、`/new` / resume / fork 都不补记冷启动。每行带 `mode`（tui/rpc/print/json），旧数据标为 unknown；所有趋势按模式分别统计，RPC child 不与 Main TUI 混合。

readyMs 是进程 time origin 到 startup session_start 的观测边界，另拆到本扩展模块求值、模块求值到 ready 两段；这不是宿主精确扩展加载专用计时 API。firstObservedFrameMs 是 startup 后通过公开 widget 入口能观察到的首个成功 doRender。**当前 stock Pi 的 ui.start() 早于 session_start：真实 PTY 检查确认挂载前已有绘制，因此 firstObservedFrameMs 不是整个进程的首个画面。** 它只代表首次可观测的会话就绪帧，不能用作 Enter→首画面基准；要测真正首帧需宿主提供更早的边界。本包不为此常驻第二个全局 wrapper。缺 launcher 时省略 launcher→该帧的时间；不显示零。首次绘制临时实例 hook 在完成或退役后恢复。

```text
/perf             最近 7 天趋势和当前状态
/perf 7d|30d      按日期、Pi 版本、插件组合对比冷启动、RSS、CPU、loop p99
/perf top        插件 span 的 p95 排序（不读取 daily）
/perf memory     当前、基线与峰值内存（不读取 daily）
/perf export     导出包含最近 30 天趋势的独立 HTML
/perf open       导出并显式调用系统浏览器打开
/perf log        慢日志位置与阈值（不读取 daily）；写入故障及持久维护错误在 /perf 命令中警告
/perf reset      清空当前细粒度聚合和 timeline；不删除长期历史
/perf on         开启采样并启用细粒度 TUI / 插件探针
/perf off        整体关闭采样，释放定时器、observer 和直方图，持久保存
```

配置在 `<agentDir>/extensions/pi-perf/config.json`，使用 `schemaVersion: 1`、`revision`、`overrides.enabled`，完整文档原子替换；损坏文件保留且只读、关闭采样。写入时发现外部修改拒绝覆盖，需重启后重试；不承诺配置的跨进程事务锁。未知字段保留但不生效。重启后细粒度探针始终关闭，低频采样遵守保存的 enabled。

`PI_PERF_ENABLED=0|false|off` 可在本次启动关闭；显式 `/perf on` 可恢复。`PI_PERF_MEMORY_SAMPLE_MS` 仅控制显式 on 后的细粒度内存采样（默认 10000）；合法的 Node timer 值保持不变，空值、非数、负数、低于 1 或超过 2147483647 回退默认。阈值类参数单独校验，允许 0（全部记录/每次触发）和正小数；非法或溢出回退默认，不套用 timer 的最小 1ms 规则。慢日志默认 50ms（`PI_PERF_LOG_MS`）、细粒度内存日志默认 60000ms（`PI_PERF_MEMORY_LOG_MS`）、loop stall 默认 50ms（`PI_PERF_LOOP_STALL_MS`）。

## 可选协作与降级

`rpiv:ask-user:blocked` 与 `ask_user_question` 工具生命周期是对可选问卷插件的只读观测，仅用于把 Enter/关闭/恢复延迟归类为问卷交互。没有对应插件或事件时不产生这类指标，输入、渲染、其他采样正常，不 import 或依赖该插件，也不参与问卷判定。

本包唯一拥有全局 TUI / input instrumentation 和日志。`pi.perf.ui-metrics.v3` 供 CC Style 订阅，`pi.perf.telemetry.v1` 供 CC Style、Session Naming 等 producer 上报；缺本包时消费者不采集，不自行新增全局 wrapper / timer。默认只提供禁用的细粒度 registry，producer 调用是 no-op。v2 冲突拒绝安装并提示重启；相容 v3 跨 reload 加入原 owner，不重复包装。observer 任一方法抛错仅隔离该 callback，其他 observer、原始输入、渲染和原始异常照常；`/perf` 保留有界诊断。

进程内 runtime lease 同步退役旧 owner，旧 disposer 不释放新 owner；默认低频模式的 reload 接管不安装 timeline 定时器，细粒度 timeline 仅在显式 on 后采集。正常 shutdown / reload 释放所有资源。可选宿主 reload-cache / replacement-GC marker 仍报告 active、override、missing 或 incompatible，不要求安装宿主补丁。

`bin/pi-launcher.zsh` 是可选启动边界示例，仅一次读取 `EPOCHREALTIME` 后拆分秒和微秒，`exec` 同级 `pi-binary` 或显式 `PI_PERF_REAL_PI`。它只传 `PI_PERF_LAUNCH_EPOCH_US`；不自动安装，不覆盖现有 pi。缺 launcher 时省略 launcher→first-observed-frame，而非记为零。

## 文档

- [持久化与趋势](docs/storage.md)：目录、并发、保留、汇总口径、隐私和故障边界。
- [能力协议](docs/protocols.md)：v3 UI、v1 telemetry、owner、可选消费和数据约束。
