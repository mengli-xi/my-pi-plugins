# 持久化与趋势

入口见 [README](../README.md)。`<agentDir>` 来自公开 `getAgentDir()`，遵守 `PI_CODING_AGENT_DIR`。

## 原始数据

`perf/raw/YYYY-MM-DD.jsonl` 按记录时间的 UTC 日期滚动。每行包含：

- `at`：epoch 毫秒；`kind`：`sample` / `startup` / `session`。
- `pid`、`piVersion`、`mode`、`run`（随机 runtime ID）、排序去重的 `packages` 包名与 `packagesHash`。
- `values`：有限数值字段，不写缺失值或 NaN。

插件清单只认 settings.packages 与 CLI `-e` / `--extension path` / `--extension=path` 明确指向的包根，读取该根目录自己的 package.json.name，不向父目录查找。显式单文件、.pi/extensions 中的单文件、没有自身 manifest 或无法解析根目录的资源统一记为 `local`；不会把用户项目根的 package.json 名当作插件名。自动发现的无公开资源身份扩展不保证完整枚举，不通过猜路径补全。CLI 相对路径以进程启动 cwd 为基准；有效 settings 已丢失 user/project 来源，无法确定基准的相对 settings 路径也保守记 local，不拿项目 cwd 猜。显式 npm 包只读取可直接解析的自身 manifest，解析不到也记 local。

摘要只基于排序去重的包名（包含 local 占位符），不含路径；不比较同名包的版本/代码。解析不在 session_start 的等待链内，进程缓存按 sources + cwd 的签名区分，签名变化会刷新；记录的数值/时间先进入后台队列，包名就绪后再写盘。就绪门从构造时保持关闭，启动前的分钟样本同样等待身份；120 秒超时或解析失败用 local 保守兜底并诊断，后来成功解析可恢复正常身份。解析成功后的每条新记录包含数值型 packageResolveMs，表示实际异步 manifest 解析耗时，不是阻塞会话的时间。历史 raw 不因这项归属规则被改写。

仅 reason=startup 且当时启用才记录 ready 与可选 first-observed-frame（首次可观测绘制）两行；运行中 reload / 后启用不补记。启动样本按 mode 分组，旧版未知模式隔离在 unknown。只有含 `readyMs` 的记录计为一次冷启动。`session` 是一次被观察到的 session_start，不是唯一会话 UUID 去重，也不是活跃进程数。每分钟的 entries 是会话全部条目数，contextTokens 来自公开 context usage，可缺失。

每条有界记录最多 64KiB，用独立 `O_APPEND` 文件句柄的一次 `write` 追加，检查短写。不将一行拆成多次写入，不以“读改写整个文件”追加；本机 POSIX 文件系统上多个进程不会覆盖或交错行。支持 macOS / Linux 本地文件系统，不承诺 NFS 的 append 语义。权限：目录 0700、数据文件 0600；ui.jsonl 与 HTML 也使用该权限，异步维护会收紧已有 ui / HTML 输出权限。

异步维护删除 UTC 日期严格早于当前日期减 90 天的 raw 文件；保留边界日。raw 保留只删除符合日期文件名格式的 raw，不动其他文件或报告；daily 使用下面的独立归档规则。运行中的进程每分钟都会换到当前日期，因此无需集中写入进程。

仅 TUI 在 session_start 后调度维护，不在启动关键路径执行清理 I/O：延后 30 秒，再每六小时检查。RPC / print / json 不调度维护。每轮只有 maintenance 锁持有者合并，重新扫描 7 天以外仍有 loose JSON 或未完成 .compact 事务的日期；不使用 through 游标或 checkedOn 日期跳过。退役可取消，批次之间检查取消。

残留 tmp 回收只扫 perf / raw / reports / 维护目录和最近 3 天的 daily 日期路径，不遍历历史每一天的 run 文件。带 PID 的临时文件仅在该进程已退出时删除，存活或无权探测时保留；旧版无 PID 的临时文件需超过 24 小时。不会删除另一个活跃 writer 的临时文件。合并旧日期时，在持锁期间顺带清理该目录的死进程 tmp，archive tmp 不会因超过 7 天而永久遗留。

## 长期汇总

最近日期使用 `perf/daily/YYYY-MM-DD/<run>.json`，每个 runtime 每 UTC 日一个文件、原子 rename 更新。迟到记录每次生成一个新的 UUID loose 文件，只含该条记录的增量，避免重用已经合并的缓存总数。不同进程拥有不同 run，不共同读改写一个文件，不覆盖彼此贡献。默认模式没有 reload timeline 定时器。

当前 schema version=2：identity、会话/启动数和每个指标的固定桶直方图；不再保存原始样本数组或重复 summary。每个指标最多 1026 桶：小于 0.001 的值进入首桶，其后按 1.05 倍递增，上界约 4.99e18，超出进入末桶。桶计数可直接相加合并，p50/p95 用 nearest-rank 对应桶的几何中点估计：正常范围相对误差不超过 2.5%，低于 0.001 时绝对误差不超过 0.001，超界分位数饱和。count、sum、min/max 不近似，mean 用 sum/count。体积只由指标/桶/包名上限及计数位数决定，不随当日样本数线性增长；运行时只保留当前日 shard。

旧 firstPaintMs / launcherFirstPaintMs 只读映射为 firstObservedFrameMs / launcherFirstObservedFrameMs；新生产者不再写 first-paint 字段或指标名。v1 数组文件仍可只读转换到直方图参与查询，旧 loop 字段同时减去原 20ms 定时间隔基线并截到 0，模式记为 unknown，不与新版 TUI/RPC 冷启动混合。近期文件不原地迁移；到达旧日保留期后在相同的事务归档中转为直方图。归档只协调新版 writer；升级后使用新 Pi 进程，不让旧版本向已过保留期的日期回写。

### Run 保留与长期日汇总

严格早于当前 UTC 日期减 7 天的日期转为 `perf/daily/YYYY-MM-DD/summary.jsonl`，长期保留；近期 run 不与旧日归档竞争同一把锁。旧日多个 run 合并后，只有日汇总原子发布成功才删除源 run。日汇总第一行是 version=1 的 daily-summary header（日期、事务 token、组合折叠标记），后面每行是可合并的 v2 cohort 直方图；不是会话原文。

每日期最多保留 32 个明细版本/包组合 cohort，超出部分按运行模式汇入 mixed / other，TUI 与 RPC 等模式不混合。汇总整体上限 8MiB；若实际编码仍超过上限，继续将明细组合折叠到各模式的 other。查询明确提示已折叠，不声称保留所有旧组合的细节。总数和分布贡献仍合并，不丢弃溢出的采样。

写入端只追加 raw 和发布 loose run 文件：不读取 summary 是否存在、不拿日锁、不读改写 archive。迟到增量也一样，由下一轮维护合并；趋势端同时读取 loose 与 summary。只有拿到 maintenance 锁的进程负责合并，日期锁协调维护与查询，不参与采样写入。

归档按最多 128 个源 run 一批，在日期锁内先发布 `.compact/state.json` 事务 token，再将源文件移动到该暂存目录。新日汇总 header 写入同一 token 后原子替换。进程中断后：token 未提交则继续合并；已提交则只回收暂存源文件，不再次计数。正常并发、重复维护和提交后中断不会覆盖或重复贡献。每次维护重新检查旧日期中的 loose 文件，迟到数据不会被游标漏掉。损坏源文件保留并诊断，供人工恢复，不以“清理”静默删掉。每个日期单独捕获失败并继续下一天。坏 summary 隔离为 summary.jsonl.bad，已有隔离文件不覆盖，后续隔离加唯一后缀；原始字节保留以便恢复。累计 errorCount 和每个失败日期的最近原因原子写入 .maintenance/state.json；/perf 与 HTML 可展示，其他进程无需运行维护也能读取诊断。这是历史错误，后续成功不会伪装已经找回隔离文件里的数据。

自己的未归档 shard 损坏或超过 1MiB 时，可重建该 run 的聚合继续写入，不让它毒化每次后续采样；其余 run 不修改，之前原始记录仍可按 raw 保留期用于离线恢复。

`/perf 7d|30d` 按 UTC 日期、Pi 版本、模式、包名哈希合并；窗口含今天、不含未来。查询只打开 7/30 天窗口的已知日期路径，不扫描全部历史日期；一次总共最多读取 512 个文件，达到上限提示结果不完整。归档文件按 JSONL 流式逐 cohort 读取，每行不超过 1MiB、每行后让出事件循环；普通 run 使用异步文件 I/O，每次只处理一个不超过 1MiB 的文件，v1 转换每 256 个数值让出事件循环，每个文件后也让出，增量合并而非保留全部 shard。坏 JSON、缺版本等 identity 字段、非法分布、超限或不可读文件逐个跳过并计数；终端及 HTML 提示跳过数，仍显示有效数据。整目录不可读也明确警告；正在写入/归档或有未恢复事务的旧日期不读半成品，提示跳过的日期数。top、memory、log 等不需要趋势的子命令不打开 daily。

HTML 内嵌冷启动、RSS、CPU、事件循环额外延迟的 SVG 折线与明细表，按版本/模式/组合分系列，离线无需脚本即可看到折线。它不是跨设备因果结论。默认 `/perf` 先显示趋势，空的细粒度表格只在 on 后显示。

raw 与 daily 是先追加、后原子更新的两次文件操作，不是数据库事务。正常并发写入不丢行、不覆盖贡献；磁盘满、短写、进程在两次操作之间被强杀或掉电时，不保证 daily 与 raw 一致或掉电持久化，不做 fsync。raw 是已成功追加记录的依据，可备份用于离线修复；写入错误在 `/perf` 诊断中保留到下一次成功写入，恢复后清除；它们不阻断会话。

## 隐私与细粒度数据

长期数据只有数值、运行模式、版本、PID、随机 ID、包名和包名哈希，不写会话内容、提示词、工具参数/结果、用户名或路径。哈希不是对本地已知配置的匿名性保证。无上传、远端服务或 provider 请求。

显式 `/perf on` 后，旧细粒度日志 `perf/ui.jsonl` 和最多 10000 项的内存 timeline 保留指标、owner、interaction ID 与有界标量标签；producer 必须只发布闭集枚举、计数或不透明 ID，禁止用户文本、路径、命令和工具 payload。协议只能限制类型和长度，不能辨别任意字符串的语义。细粒度日志不属于 90 天 raw 清理；超过 64MiB 时改名为 `ui.jsonl.1` 再新建，只保留这一份旧文件。`/perf reset` 只清内存聚合，不删除任何磁盘历史。HTML 在 `perf/reports/`，嵌入转义后的数据、CSS 和脚本，不用 CDN；显式 open 才启动浏览器。
