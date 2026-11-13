# pi-processes

为 Pi 提供 supervised background process：用 `process` tool 启动命令、等退出或日志条件，并通过 `/ps` 查看状态与保留的输出。进程使用 pipe，不提供 PTY。

## 加载与构建

stock Pi 版本见[根支持说明](../../README.md#支持说明)。按[根安装说明](../../README.md#安装与加载)安装依赖，再构建本包：

```sh
npm run build -w pi-processes
pi -e "$PWD/local/pi-processes"
```

Pi 加载 `dist/index.js`；构建还生成独立的 `dist/supervisor.js`、`dist/matcher-worker.js`、child factory 与按需加载的 manager view。源码或 source-only library 依赖变更后，重建并新开 Pi process，不用 `/reload` 代替 rebuild/restart。

空会话只建立 Host/binding，不启动 Supervisor；首次 process 操作才选择 helper runtime 并握手。普通配置下，命令可在同一 session 内跨 extension `/reload` 存活；managed/isolated scope 不 reclaim 旧 Host。session scope 结束、package 被移除或未被 reclaim、Pi 退出时会清理对应进程，具体边界见[执行合同](docs/MANAGED_EXECUTION.md)。

## 工具与命令

`process` 支持七个 action：

| action | 用途 |
| --- | --- |
| `start` | 启动命令，设置 name、kind、watch、notification、continuation 和可选 timeout |
| `list` | 按状态筛选、排序并分页列出 record |
| `logs` | 读取有界 retained log，可按 stream、pattern 过滤 |
| `input` | 写 stdin 或发送 EOF |
| `configure` | 修改 live process 的名称、kind、watch、continuation 或 notification policy |
| `stop` | 停止 live process group |
| `clear` | 删除 terminal record 和 retained log，不移除 live process |

name 在 live process 中必须唯一，最多 16 个 terminal column。kind 为 `process`（默认）、`monitor` 或 `service`。不要用 `&`、`nohup`、`setsid`、`disown` 或 daemonizing command 绕过监督。

```json
{
  "action": "start",
  "name": "tests",
  "command": "npm test",
  "timeout": 600,
  "continuation": {"mode":"wait","until":{"kind":"exit"}}
}
```

`start` 在 Supervisor 确认进程后返回，不表示命令已完成。`continuation.mode="wait"` 仍 blocking 时应结束本轮，等待 exit 或指定 watch 唤醒；不轮询、不 sleep。省略 continuation 默认 detached。工具的完整使用示例见随包加载的 [pi-processes skill](skills/pi-processes/SKILL.md)。

`/ps` 无参数，打开 process browser。editor 上方的 strip 右对齐显示 `ps · name · name`；terminal name 保留 5 秒后隐藏，不删除 record。点击 name 直接打开 detail，Esc 关闭该次 invocation；从 `/ps` list 进入 detail 时，Esc 先回到 list。界面、故障显示和 containment 行为见[宿主与界面合同](docs/PI_HOST_DEPENDENCIES.md)。

## 配置

配置来自实际 `getAgentDir()/pi-processes/config.json`；`getAgentDir()` 遵守 `PI_CODING_AGENT_DIR`，不猜测其他进程的 agent directory。

```json
{
  "schemaVersion": 1,
  "execution": {
    "helperRuntime": "<verified-runtime>/helpers/bun",
    "isolation": {
      "version": 1,
      "owner": "example-owner",
      "revision": 1,
      "removeEnv": ["EXAMPLE_BROKER_ID", "EXAMPLE_REPLY_FD"]
    }
  },
  "managed": {"requireTimeout":true,"maxTimeoutSeconds":7200,"terminalWake":"required"}
}
```

shell 接受绝对路径的 sh、dash、bash、zsh（Linux `/bin/sh` 可指向 dash），仍校验可执行性及 isolation authority。

这是受管配置示例，不是日常运行的必填设置。`managed` 和 `execution.isolation` 只允许出现在 agentDir 配置。可信 launcher 可在 Pi 启动前声明 `PI_PROCESSES_REQUIRED_ISOLATION`，Core 随后核实 owner/revision 与冻结配置；未声明的 launcher 不会被自动识别或剥离外部专用 env key。声明格式、removeEnv、authority 漂移、timeout 与清理规则见[执行合同](docs/MANAGED_EXECUTION.md)。本包不写入或自动迁移日常配置。

## 可选协作与降级

- `pi-session-inject` 是共享库依赖，唯一拥有 `pi-session-inject/mailbox-v1`、`/mailbox`、持久 acceptance、native append/proof 与 control；本包拥有 notification broker 和业务 settlement。[Mailbox 合同](docs/MAILBOX.md) 定义完整身份、持久格式、admission、恢复与故障语义。
- `statusline:processes-snapshot-v2`、`processes:snapshot-request-v2`、`processes:open-request-v2` 提供语义状态和打开请求。CC Style 可按 `process | monitor | service` 聚合 live role；本包不自行 render statusline。没有消费者时，`process`、`/ps` 和 strip 照常使用。
- `processes:managed-snapshot-v1` 与 `processes:managed-snapshot-request-v1` 提供只读受管状态，不授予控制或 ownership；无消费者不影响 Core 执行。[执行合同](docs/MANAGED_EXECUTION.md) 定义字段与 consumer 校验。
- Subagent child 通过 `process-wait-bridge-v2` 请求 Task admission。缺 bridge/owner 时保留同一 prepared batch 并 hold，不猜测授权；已 final 的 Task 不因 process terminal 重启。[Mailbox 合同](docs/MAILBOX.md) 定义 grant 和取消边界。
- Goal continuation claim 通过 `goal-continuation-obligation-v1` 查询活性；没有有效 claimant 时回到 producer wake，unknown 则 hold 并诊断，不读取 Goal 私有存储。
- Main/Side 可同步回复 `pi-session-compact:collect-recovery-v1`，并依据 owner/customType marker 去重；没有该消费者时沿用公开 `session_compact` 后的无 wake 补注。child 不安装这个 helper。正文与时序边界见[压缩状态恢复](docs/MAILBOX.md#压缩状态恢复)。

SDK child/Side factory 的导出、scope ownership 和 lazy runtime 约定见[宿主与界面合同](docs/PI_HOST_DEPENDENCIES.md)。各可选插件独立加载或缺失都不能授予额外执行权限。

普通 child factory 的声明与共享装载规则见 [child-capabilities-v1](../pi-runtime-contracts/docs/child-capabilities-v1.md)；外部 provider grant 不由这个声明授予。

## 验证

在仓库根目录运行：

```sh
npm run check -w pi-processes
npm run test:e2e -w pi-processes
npm run test:e2e:late-turn -w pi-processes
npm run test:e2e:mailbox -w pi-processes
npm run test:integration
```

包内验证只覆盖本包离线单元、合同和隔离 faux-provider 场景；跨插件、缺失协作方与加载顺序矩阵由[根 integration](../../integration/README.md) 管理。不读取日常 profile，不发真实 provider 请求。宿主基线与验证边界见[宿主依赖](docs/PI_HOST_DEPENDENCIES.md#公开宿主接口)。

### 使用时顺手回归

使用独立临时会话，不拿正在工作的 service 做清理或超时实验：

- 启动 `printf 'ready\n'; sleep 2; printf 'done\n'`，在普通配置设置一次性 literal `ready` watch、`notify.onSuccess="ignore"` 并等待该 watch：只由 watch 唤醒一次；日志保留 ready/done，退出后仍可读取。
- 启动 `trap '' TERM; sleep 30`，设置 `timeout: 1`：约一秒后开始 TERM，五秒宽限后仍存活就 KILL；界面显示 failed/timeout，不把宽限内退出显示为成功，不能靠 configure 续期。
- 打开 `/ps`，从列表进入日志后按 Esc 返回列表；从 strip 直接进入日志后按 Esc 关闭。缩窄窗口仍能辨认状态，clear 不删除 live process。
- 普通配置下让命令跨一次 extension reload：PID 与原 deadline 不变；退出临时会话后整组清理。managed/isolated scope 不用于验证旧 Host reclaim。
- 单独启用 Processes、不装 CC/Goal/Subagents，确认启动、日志和 `/ps` 仍可用；启用 Subagents 后，在其 Task 等待 Process 时取消 Task，迟到的退出通知不得创建新 Task 或恢复执行权限。
- 有 Compact 时，让 Main/Side 保持命令运行并连续压缩两次：每次只恢复一份 live 状态，下一轮不重复启动命令；没有 Compact 时原生压缩仍可继续。child 不按 Main/Side helper 的覆盖范围验收。

真实 provider、人工鼠标/IME、完整 profile 与外部 launcher 的隔离接线须分别验收，不能用上述自动化命令代替。

额外 real/native 套件统一用 `npm run check:upgrade -w pi-processes`；构建与完整验收规则见[升级 Pi](../../CONTRIBUTING.md#升级-pi)。

## 合同文档

- [MAILBOX.md](docs/MAILBOX.md)：notification 的身份、持久 entries、admission、Goal/Task 协作、branch/reload、取消与压缩恢复。
- [MANAGED_EXECUTION.md](docs/MANAGED_EXECUTION.md)：配置 authority、required isolation/removeEnv、deadline、受管 snapshot、Supervisor containment 与遗留 root 清理。
- [PI_HOST_DEPENDENCIES.md](docs/PI_HOST_DEPENDENCIES.md)：公开 Pi API 基线、Main/Side/child factory、按需启动、界面行为与故障展示。
