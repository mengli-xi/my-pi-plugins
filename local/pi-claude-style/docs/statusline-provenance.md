# Statusline contract 与来源

`src/statusline/` 源自公开 npm package `pi-statusline@0.0.2`（[upstream](https://github.com/hsingjui/pi-statusline)），现作为 CC Style 的本地维护实现，不再作为独立 Fork 跟踪。原始发布可通过 `npm pack pi-statusline@0.0.2` 取得。当前行为由本文与 [README](../README.md) 定义，不由旧上游说明定义。

## Shell 与数据边界

`statusLine` 的 command/placement/timeout 属于 Pi settings；CC 是通用展示 host，不拥有外部脚本的实现或领域状态。command 通过 shell 执行，stdin 收到 JSON，stdout 返回带 ANSI 的行，tab 分隔可伸缩左栏与右对齐栏。这不是 sandbox：脚本继承进程环境和操作系统权限，可能访问其可读文件或网络，CC 不保证脚本“无法读会话”。

payload 含 cwd/workspace、model/provider、effort/effort_level、session id、terminal width、usage/cost/cache、todo、`pi.session_started_at_ms/refreshed_at_ms`，以及两个明确的文件入口：

- `pi.session_file` 是公开 SessionManager 报告的真实 Pi session 路径；
- `transcript_path` 通常是 `<agent-dir>/statusline-transcripts/<session-id>.jsonl` 的 Claude-like usage projection。无 session id 时按 cwd digest 命名；写 projection 失败可回退到真实 Pi session 路径。

projection 只写 user/assistant 的标识、parent 和 assistant usage，不把正文、thinking 或 tool payload 复制进去；**这不限制脚本通过 `pi.session_file` 或自身权限读取原始会话。** analyzer 从公开当前 branch 取数据，按 count/tail id 版本复用解析结果，append 只处理新增条目；branch 改变/失效时重建。同一 invocation 的写操作串行，unchanged branch 不反复解析或重写。

仓库可选的 `assets/statusline.mjs` 在 command host 之外：它读 stdin，并会读取 `pi.session_file` 计算 turn/compaction 等计数与 legacy 缺字段 fallback；它不读 `transcript_path`。脚本按文件 identity/size/mtime/ctime 检查版本，只缓存数字摘要，canonical 内容相同不写；显式 0/null 具有权威性，不从旧分支复活 usage。cache 可用 `MY_PI_STATUSLINE_CACHE_DIR` 指到隔离目录。这里描述的是该资产的实现，不代表任意用户 command 的权限限制。

外部脚本不是 CC package 的内嵌资源；profile owner 需显式配置已存在的 command，不能以文档链接或不存在的 stub 代替资产。测试 `test/statusline/external-script.test.ts` 依赖仓库真实 `assets/statusline.mjs`，不读取用户脚本或数据库。

## Usage、压缩与 cache

compaction 在 branch 顺序中位于有效 usage 之后时立即清掉旧 request baseline、cache quality、duration 与 200k 标记，但保留会话累计流量、费用和 cache samples。原生/extension compaction 共用边界；`session_compact/session_tree` 使缓存失效，reload 从 branch 重建。下一条成功且非零 usage 恢复 measured baseline，error/aborted/全零 usage 不冒充新观测。

等待新 usage 时，用公开 `buildSessionContext(branch)` 与 `estimateTokens` 估算有效 conversation；包含 summary、保留消息和 system replay，但不包含 provider 后续 prompt/tool overhead。估算填入 `current_usage.input_tokens`，output/cache 为 null，百分比来自同一值；`usage_source` 为 `estimate/usage/pending/null`，`estimated_tokens` 仅估算时有值。projection 失败则清 usage/百分比并置 pending，不回退压缩前值。外部资产在 estimate 时显示 `~`，pending 显示待更新状态。

`CH` 为当前 `cacheRead/(input+cacheRead+cacheWrite)`，`RU` 为相对上一轮可复用 prompt 的命中率，`M` 为未复用 token；无 cache activity 不把未知当 0。host 拥有 `cache-quality` slot，点击与 `/cc-style cache` 打开同一 active-branch 趋势。compaction/branch summary 断开 reuse baseline，model switch 保留并标记；面板固定 0–100% 刻度、token 加权汇总和有界请求明细。

## 首帧、刷新与贡献项

Main 在 `session_start` 同步挂载 CC 模板；Subagent attach 同步挂载本视图的 cwd/model/effort 只读帧，Side 保留自身首帧策略。Main 冷启动在 session_start 前仍可能出现原生 footer，不假称零帧。成功 command 替换兜底；失败、空输出和 timeout 保留上次成功帧，无成功帧则保留兜底。尚无成功输出时有有界 1s/3s/8s backoff，event refresh 重置；apply 前复核 context owner，不能写回已替换 UI。

最后成功帧按 session、command 与配置校验后用于 reload handoff，不借用其他 session 或 Main/child 帧。view detach 清理本视图；session 切换 cache 失效，replacement 的 session_start 刷新。不要依赖不存在的 session_switch/session_fork event。

- footer/widget 遵守 `statusLine.placement`；widget 模式不清除别人的 footer。
- `statusline:row` 通用 host 支持 row、align、slot、可见宽度与 click spans；command 行数不足时 clamp，实际 terminal 宽度在 host render 后换算右栏偏移。分隔符由 host 用 dim tone 合成，不破坏 contributor ANSI。
- `path-full/path-short` slot 选择 full/basename，`@N` 限宽仍保留 click span；点击打开完整绝对路径的可复制 panel。model slot 复用 editor 的 `app.model.select`，effort slot 由 effort owner 提供。
- 宽度策略归脚本；路径/model/session age、turn/compaction 与 context/accounting 的排布由 profile 选择。Git 状态属于 editor chrome，不在 shell 内复制其领域实现。
- `processes` key 由 CC 唯一生产，领域状态来自 Processes V2；Todo/Goal/Model Capacity 消费 semantic snapshot。Goal 按自己 scheduler 更新，不依赖 shell turn refresh；同步 handoff 无接收者时按配置回退 widget/setStatus。
- child 不接 Main 外部 contributors；Side 仅接自身允许的 contribution。`Alt+/ Main` 在 child editor bottom label，不增加 footer 高度。
- `statusline:refresh` 是 debounced command 重跑入口；单纯贡献项更新不强迫 shell 往返。分钟级 heartbeat 推进 session age，timer 随 runtime 释放。

## 取消与有界回收

POSIX command 以独立 session/process group 启动，TERM/KILL 发给该组。timeout 触发后保留原来的两秒 TERM 宽限；abort（刷新替换、detach、shutdown）给 TERM 250ms，随后 SIGKILL，最多再等 750ms。timeout 已进入宽限时收到 abort 会缩短到 abort 预算。所有时限以 event loop 能调度 callback 为前提。

正常 `close` 决定保留何种输出；event loop 阻塞导致 timeout callback 先于已到达的 data/close 时，不能立即丢弃已成功产生的帧。KILL 后最终截止时间到达仍未 close，或组查询仍为真，则销毁本端 stdin/stdout/stderr、清 timer/listener，返回空结果；保留直接 child 的 exit 回收，不用 unref 隐藏未回收进程。

`close` 还等待继承管道关闭，`kill(-pgid, 0)` 仅表示仍能查询该组，两者都不能导致 KILL 后无界等待。主动另建 session 的进程不能由原组信号追杀；释放本端 fd 不依赖它配合。view detach/shutdown await 所有在途命令，包括先前被刷新取消的命令；这不是任意后代都已终止的保证。

## 验证入口

`test/statusline/{payload,transcript,install,command,command-deadline,external-script}.test.ts` 覆盖 payload/缓存/首帧/进程树/边界。`bun test/integration/context-compact.mjs /path/to/pi` 在临时 HOME 和 faux provider 中检查原生/extension compaction；默认使用仓库资产，`CC_CONTEXT_STATUSLINE` 可换成显式可执行脚本，`CC_CONTEXT_STATUSLINE_PATCH` 仅定制该 fixture。`CC_CONTEXT_COMPACT_ARTIFACTS` 保存隔离产物。运行命令前确认真实资产和依赖存在，不把缺失资产或零测试当通过。
