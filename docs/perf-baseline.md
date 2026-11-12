# Pi 性能基线

## 复现

先按[安装与加载](../README.md#安装与加载)安装根 lock 的依赖并构建七个有生成产物的包。
需要 Node 24、Bun 1.3、Perl；Pi 版本从根 `package.json` devDeps 读取。
入口经公共 `check-host.mjs` 隔离配置并核对 CLI/SDK 版本，基准独立于 pi-perf。

```sh
uptime
npm run bench:perf -- --output .perf-baseline/replay
```

默认冷启动及各 resume 检查点各跑 10 次；连续长轨迹每配置一条。
全部阶段串行执行，各阶段限时 2400 秒，整套可能超过两小时。
输出包含 `index.json`、逐次/逐轮 JSON、会话检查点和 V8 profiles；测量产物不提交。

常用单阶段命令：

```sh
perl -e 'alarm 2400; exec @ARGV' bun scripts/bench/run.mjs --suite smoke --output .perf-baseline/smoke
perl -e 'alarm 2400; exec @ARGV' bun scripts/bench/run.mjs --suite cold --bundled --repetitions 10 --output .perf-baseline/cold
perl -e 'alarm 2400; exec @ARGV' bun scripts/bench/run.mjs --suite long --trace-only --only all --rounds 1000 --output .perf-baseline/long
perl -e 'alarm 2400; exec @ARGV' bun scripts/bench/run.mjs --suite resume --only all --repetitions 3 --session-source .perf-baseline/long/001-all/session.jsonl --output .perf-baseline/resume
perl -e 'alarm 2400; exec @ARGV' bun scripts/bench/run.mjs --suite idle --only all --idle-seconds 600 --output .perf-baseline/idle
perl -e 'alarm 2400; exec @ARGV' bun scripts/bench/run.mjs --suite profile --only all --rounds 20 --session-source .perf-baseline/long/001-all/session.jsonl --output .perf-baseline/profile
node scripts/bench/analyze.mjs .perf-baseline/cold .perf-baseline/long .perf-baseline/profile
```

`--only` 支持 `none`、`all`、包目录名及 `without:包目录名`，可用逗号组合。
`--git` 初始化临时 Git cwd；`PI_BENCH_NODE=/absolute/path/to/node` 选择被测 Node。
默认答复 24 个 Markdown block、工具输出 32 行；加 `--reply-blocks 48 --tool-lines 96` 可加重负载。

## 测量边界

- 真实 Node CLI、112×38 regular PTY；每次使用独立 HOME、agent、session、XDG 与临时缓存，固定本地 faux provider。自动 compact/retry/cache warming 关闭。
- `all` 为全部 24 个仓库插件，含 Gallery 与四个 Fork；共享库成本归消费者。`none` 保留共同探针、faux 和宿主内建功能。
- 冷启动从进程启动到 `/bench-ready` 被处理；`--bundled` 测正式 bin。import/factory/handler/帧细分来自未打包 CLI 的内存钩子，两种模块图分别比较。
- 每轮真实输入、一次 read、2256-byte Markdown 答复及 1568-byte 工具输出；轮耗时为 input→全部 settled handlers 完成，随后留 40ms 排空最终帧。尾窗取第 901–1000 轮。
- resume 复制检查点到新 profile，只重定位 header.cwd，校验恢复用户消息数。本摘要每检查点采样 3 次，对应上面的显式 `--repetitions 3` 示例。
- handler 墙钟包含异步等待与 UI 阻塞；共享 hook 可挂在首个注册插件名下。帧时延计到 doRender 完成，RSS/heap 未强制 GC。
- 空闲 CPU 含周期探针成本，一核为 100%；heap profile 表示采样分配。CPU/heap profiler 单独开启，用于定位及配置消融。

## 摘要

Pi **1.5.0**，**2026-11-12 UTC**；Apple M5 Max **18 核 / 128 GiB**，macOS 26.5.2（Darwin 25.5.0）。
Node **24.22.2 arm64**，Bun **1.3.14**。
机器有外部负载（1 分钟负载 10–55），小差异不可信。

这些数字由旧探针测得，只作历史参考；优化前后对比须用同一版工具重测。

| 场景 | 配置 | 耗时 median / p90 | 宿主 CPU | RSS / heapUsed MiB |
| --- | --- | ---: | ---: | ---: |
| 正式冷启动，n=10 | none | 537 / 709ms | — | 148.1 / 31.2 |
| 正式冷启动，n=10 | all | 9817 / 15422ms | — | 642.8 / 297.9 |
| 1000 轮尾窗 | none | 161 / 255ms | 103.5% | 753.4 / 486.6 |
| 1000 轮尾窗 | all | 3215 / 3825ms | 110.9% | 1364.1 / 605.0 |
| 1000 轮 resume，n=3 | none | 4.63 / 4.80s | — | — |
| 1000 轮 resume，n=3 | all | 14.71 / 16.15s | — | — |
| 空闲 600s | all | — | 0.122%，稳态 0.087% | 162.8 / 101.6 |
| 空闲 60s 对照 | none | — | 0.012% | 162.8 / 64.4 |
| 长历史 profile，续跑 20 轮 | all | 3793 / 5189ms | 5270ms/轮 | 1375.5 / 227.4 |
| 同转录去 CC Style | all 去 CC | 769 / 1044ms | 1005ms/轮 | 1162.8 / 720.8 |

冷启动内存为十次中位数，其余为末次样本；空闲两项 RSS 原值分别为 170704896/170688512 bytes，四舍五入后均为 162.8 MiB。
稳态去掉首 30 秒；none 的空闲时长较短。长历史 CPU 百分比包含最终帧与取样间隔，GC 等线程可令其超过一核。

长会话尾窗的帧时延 median/p90：none **63/82ms**，all **133/257ms**。
每轮平均渲染墙钟分别为 **214/2646ms**，完整取样周期 CPU 均值约 **331/4046ms**。
profile 指向整段历史的布局、宽度/图片扫描，以及 CC 的逐行围栏过滤。
去 CC 的消融同时改变显示功能，差值只作为成本上限；去 Goal 后共享 hook 耗时转移到 MCP，需按实际实现归因。

### 采样口径

以上数字保留已有数据的口径。旧 `/bench-sample` 在 `setImmediate` 才读取统计，期间编辑器复位及绘制可能被计入。
当前探针通过公开终端输入回调，在采样输入交给编辑器前冻结 handler/帧及 CPU/内存快照；新格式的轮周期 CPU 从业务 input 起算，排除上一条采样命令的尾部开销。
input→settled 业务耗时与冷启动终点保持不变。旧渲染/周期 CPU/内存聚合数据无法精确扣除采样输入开销，比较优化前后应使用同版工具重测。

## 限制

- CPU/RSS 覆盖宿主进程；独立 daemon、statusline 子进程的 CPU/RSS 尚未累计。精确小收益需同机较空载、多次复跑。
- 清理时核对快照 PID 的当前命令行，无法核对或不含本次临时目录则跳过；仅环境变量含 agentDir 的 detached daemon 需另行复核。
- 真实 provider、人工终端/IME、像素呈现、fullscreen、活跃任务及复杂私有状态恢复、已热持久缓存、patched/pinned 宿主未覆盖。
- heap 采样及未强制 GC 的 RSS/heap 不足以证明泄漏；真实网络会改变客户端成本在总延迟中的占比。

复核命令需要读取进程环境的权限；`ROOT` 取自 `run.mjs` 打印的临时目录行。命中后人工核对 PID，命令本身不结束进程。
```sh
ROOT=/private/tmp/pi-bench-XXXXXX
ps eww -axo pid=,command= | awk -v dir="$ROOT/agent" 'index($0, dir) && $0 !~ /awk -v dir=/'
```
