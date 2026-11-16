# pi-scheduler

## 用途

持久定时任务。agent 通过 `schedule_task` 创建任务；独立 daemon 在 Pi 退出后继续调度，可由 macOS launchd 或 Linux systemd user service 常驻。

任务只冻结一段自包含 prompt，不复制当前历史。目标必须明确，未指定时 agent 应先询问：

- `agent`：每次运行新建隔离 Pi session，冻结创建时的 cwd、provider、model、thinking；配置不可用明确失败，不静默换模型。
- `session`：投递到指定 session，使用它的历史与模型。live session 空闲时通过共享 durable mailbox 投递，transcript 显示为 `task`，入模仍是 user 语义；无人持有时由 daemon 在原 cwd/sessionDir 恢复执行。

## 加载与构建

Pi 版本见[根要求](../../README.md#要求)；运行时需要 Node.js 22.19+ 或 Bun。必须先在[仓库根](../../README.md#安装与加载)安装依赖并构建；不提交 `dist/`：

```sh
bun install --frozen-lockfile
npm run build -w pi-scheduler
pi -e "$PWD/local/pi-scheduler"
```

硬依赖共享库 `pi-session-inject`（`mailbox-v1`）和 `pi-li-uikit`，不是对其他插件的依赖。修改源码或 mailbox 后重新构建并启动新进程，不以 `/reload` 代替。

## 配置与命令

`schedule_task` 支持 `create`、`list`、`cancel`、`pause`、`resume`、`runNow`。创建需 `title`、`prompt`、`schedule`、`target`；可选 `timeZone`、`toleranceMs`。时区默认捕获创建时的 IANA 时区，迟到容忍默认 5 分钟。

| schedule | 含义 |
| --- | --- |
| `{kind:"once",at:毫秒时间戳}` | 一次性 |
| `{kind:"daily",at:"09:00"}` | 每天指定时刻 |
| `{kind:"weekly",dayOfWeek:0,at:"09:00"}` | 每周，0 为周日 |
| `{kind:"interval",everyMs:60000}` | 固定间隔，至少 60 秒 |

按固定时区处理夏令时。休眠、停机和忙碌都计入同一迟到容忍；指定时刻超时跳过，间隔任务在容忍内只合并补跑一次，按计划时间而非完成时间推进。同一任务不重叠，失败不自动重试，可手动 `runNow`；live session 的手动执行不绕过占用保护。

人工入口：

- `/schedule` 或 `/schedule list`：查看任务。
- `/schedule cancel <id>`：删除任务。
- `/schedule failures`：查看并确认未读失败。
- `/schedule install`：**显式写入并加载系统服务**。仅在希望持久常驻时由用户执行；测试不运行此命令。
- `/mailbox status|resume|recover <session-id>`：由共享库提供，见[mailbox 合同](../pi-session-inject/docs/mailbox-v1.md)。resume 只解除 transport 恢复 hold，不替代业务授权。

首次工具/命令使用会经服务管理器启动已有服务，失败则直接启动独立 daemon；未安装服务的直接进程不保证重启后恢复。安装写入 `~/Library/LaunchAgents/` 或 `$XDG_CONFIG_HOME/systemd/user/`（默认 `~/.config/systemd/user/`）。用户服务依赖登录环境；Linux 注销后持续运行需系统的 user lingering 策略，安装器不修改它。

运行路径、并发和服务环境配置见 [配置](docs/configuration.md)。

## 存储与生命周期

`<agent-dir>/scheduler/` 中由 daemon 单写：

- `tasks/<id>.json`：任务定义。
- `runs/<id>.jsonl`：每任务最近 50 条、30 天内记录；未读失败保留至确认。
- `inflight/<taskId>.json`：执行中记录；进程崩溃后补失败，不自动重试。
- `injection/<id>.json`：冻结的投递/handoff intent，最终 mailbox ACK 才结算。
- `mailbox-receipts/<id>.json`（及 legacy receipt）：永久去重证据，不随运行历史清理。
- `occupancy.json`、`daemon.log`、`daemon.lock`：占用、日志与 advisory lock 诊断。

工具与命令仅走本地 Unix socket。socket 优先使用 `XDG_RUNTIME_DIR`，否则保持系统 `tmpdir()` 与原文件名；仅路径超长时使用经属主、非软链及私有权限校验的 `/tmp/pi-scheduler-<uid>/`（0700），不安全则拒绝。这个目录不是本人名下的私有目录时（例如被其他用户抢先创建），Scheduler 拒绝启动；让目录属主或管理员删掉它，或把 `XDG_RUNTIME_DIR` 设成更短的路径，使 socket 不再超长。安装服务时固定同一默认目录，路径中的空格、`%` 和 `$` 按 systemd 语法转义。占用登记使用 session ID、PID、token、generation，持久恢复并检查 PID 存活；多个 live holder 不互相接管。holder 拒绝后每 5 秒重试原身份登记，同一原因警告去重。daemon 不与 live Pi 并发写 session。

会话空闲时，真实会话活动（`agent_settled`）和 session_start 会立即拉取 daemon 的 offer；完全静默的会话每 30 秒轮询一次，因此新到期的会话任务最多晚约 30 秒被 pickup。

新 Pi 对比 bundle SHA-256 与 daemon build ID。不同则请求 drain：接受任务变更但不启动新执行，等待已有子进程记录落盘，关闭 socket、释放内核锁后启动替代者并重新登记占用。不支持 drain 的旧 daemon 不自动强杀，须人工确认无执行后停止旧进程。服务与 socket 按 agentDir 隔离，不互相替换。

## 可选协作与降级

无需加载任何其他插件。mailbox 是共享库硬依赖，缺失时不能使用 Scheduler；没有 active owner 时保留 pending，不私发 fallback。投影、wake 和 transport ACK 由共享库拥有；业务 guard、任务时效和最终记录仍归 Scheduler。离线回滚工具保留，适用时机、停机要求和命令见[mailbox 文档](docs/mailbox.md#离线回滚)。

## 验证

在仓库根运行：

```sh
npm run typecheck -w pi-scheduler
npm run test -w pi-scheduler
npm run check:host -w pi-scheduler
# 可选：指定与已安装 SDK 同版本的 stock CLI
PI_BIN=/absolute/path/to/pi npm run check:host -w pi-scheduler
```

`test` 从源码构建 daemon，使用根 loader，覆盖调度、存储、IPC、真实子进程/SIGKILL、mailbox source ACK 和 rollback CLI。`check:host` 统一经根 runner 隔离 HOME、agent、session、XDG 和 npm 配置，构建后运行 Node CLI 自动启动、source callback 以及完整 mailbox 宿主矩阵。矩阵只加载本包、共享库和测试 peer，不加载其他插件，因此属于包内宿主检查，不是跨插件联测。

官方二进制验收跳过 Node CLI 自动启动探针（它要求 Node 执行 npm 脚本入口），其余宿主子套件仍运行；二进制宿主下自动拉起 daemon 时的 `PI_SCHEDULER_BINARY` 解析路径尚无验收覆盖，这是测试缺口，不是兼容豁免。

所有入口使用临时目录、faux provider 或 stand-in，拦截服务管理器和桌面通知，不发真实 provider 请求、不安装系统服务、不改日常配置。实际服务注册、注销/重启存活、真实 provider 与人工终端不在自动验收范围。

## 文档

- [配置](docs/configuration.md)：配置来源、字段、默认值与生效方式。
- [docs/mailbox.md](docs/mailbox.md)：source 事务、legacy 导入、branch fencing、离线回滚和宿主矩阵。
- [docs/design.md](docs/design.md)：当前设计取舍与执行保护。
- [docs/glossary.md](docs/glossary.md)：任务、计划时间、投递和 ACK 术语。
