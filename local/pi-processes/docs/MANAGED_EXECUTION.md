# 执行与受管策略合同

`managed`、deadline、Supervisor、mailbox wake 和 ownership snapshot 均归 pi-processes Core；任何 integration 都不能重写这些执行策略。只有外部身份字段与线协议转换归 integration。

## 配置 authority

Core 从调用会话的实际 `agentDir` 读取 `pi-processes/config.json`，不从 integration 的加载情况推断 managed 身份。`managed` 与 `execution.isolation` 只允许出现在 agentDir 配置；可信项目也不能声明它们。agentDir 声明 managed/isolation 或调用进程声明 required isolation 后，项目不能覆盖 `execution.helperRuntime`，包括相同值、`auto` 和 `null`。

Core 用冻结的配置创建 scope/Host 与 tool schema。受管执行要求显式 timeout，执行端仍核实上限；项目或 caller 不能通过 detached、ignore/context、已触发的 watch、reload 或 configure 取消 terminal wake 或延后 deadline。Supervisor 自己持有单调时钟 deadline，Host/模型不拥有续期能力。

## 只读 managed snapshot v1

- Owner：pi-processes。
- Broadcast：`processes:managed-snapshot-v1`。
- Synchronous request：`processes:managed-snapshot-request-v1`，`{version:1, scope_id:string, requestId:string}`。
- `scope_id` 必须等于已 attach 的当前 managed session；两个字符串均须非空且不超过 256 个 UTF-16 code unit。最近 128 个 request ID 去重；detach/attach 清空去重状态。
- `source` 等额外 caller metadata 不提供授权，也不限制 caller。该同进程只读 event bus 不是安全边界，不授予 process 控制权或 ownership。旧 caller 可继续携带其 source 字段，无须转换 snapshot。
- consumer 先订阅再请求；因此 producer/consumer 两种加载顺序都可收敛。detach 后停止发布，迟到的旧 scope 请求不得得到当前 scope 数据。managed reload 不 reclaim 旧 Host；consumer 必须拒绝意外的 `host_generation` 变化，不能把旧 release 套到新 generation。

快照只含 JSON-serializable 数据：`version`、`scope_id`、`host_generation`、业务 `revision`、`starting_count/running_count/stopping_count`、`processes`、`supervisor_key`、`groups`、`release_groups`、`wakePending`、`cleanup`。不含 command、cwd、name、日志或正文。重复读取不推进 revision，实际业务/wake 变化才推进。

`processes` 包含 pending spawn，starting 阶段 `timeoutMs` 已知，`deadlineAt/group_key` 可为 null。spawn 成功后，Supervisor 给出 deadline。PID/PGID/parent PID 都只是候选；consumer 必须自行从内核验证 PID birth 与归属，不可只凭数字 signal 或认领。

`groups` 保留这个 Host 已 ACKed 的全部 spawn 候选，包含短命令和已 clear 的 terminal；缺少 active process 不是 release ACK。terminal group 在 `release_groups` 中持续出现，consumer 在自己可靠记录 ownership/release ACK 后才能去除本地候选。Core 不接收或伪造外部 ownership ACK。

`wakePending` 投影 broker turn window、prepared batch 与 mailbox source receipt，包含尚未 put 和已记录但尚未模型消费的工作。recorded/transport ACK 不等于有效模型轮次消费。关闭状态为 `closing/closed/unknown`；cleanup 未收敛不能冒充 closed。

## Required execution isolation v1

可信 launcher 在 **Pi 实际进程环境** 设置 `PI_PROCESSES_REQUIRED_ISOLATION`，内容是严格 JSON：

```json
{"version":1,"owner":"example-owner","revision":1}
```

同一进程解析后的 `agentDir/pi-processes/config.json` 设置：

```json
{
  "schemaVersion": 1,
  "execution": {
    "isolation": {"version":1,"owner":"example-owner","revision":1,"removeEnv":["EXAMPLE_BROKER_ID","EXAMPLE_REPLY_FD"]}
  }
}
```

`owner` 为 1–128 个 ASCII identity token 字符（首字符字母/数字，后续还可用 `._:-`）；`revision` 为正的 safe integer。`removeEnv` 是至多 256 个唯一 env key，符合 `[A-Za-z_][A-Za-z0-9_]{0,127}`；Core 排序、复制、深度冻结它。未知字段、重复 JSON key、空/无效 required 声明都拒绝。required 声明不能携带策略或 callback；只有可信 agentDir 文件能提供键列表。

required 存在时，agentDir 策略必须存在且 owner/revision 完全相等；即使没有 `managed` 也适用。显式 `managed` 配置始终要求 isolation 策略，不能因 required 声明或 外部 adapter 缺失而降级。没有 managed、isolation 或 required 的日常配置继续使用原来的普通执行模式，不清空普通环境。

Core 每次 start、冷启动前后都检查冻结 authority。required 声明改变/消失、global managed/helper/isolation 改变、项目后加 override 均拒绝新 command，要求 fresh session；同一 scope 的 Host 不能 rebind 到另一套 authority。managed/isolated reload 不 reclaim 旧 Host，防止让新策略继续使用旧 Supervisor。没有这些策略的普通 reload 保留原行为。

文件读取先比较 `dev/inode/size/mtime/ctime`，未变化时复用已解析的 JSON（包括解析失败）；读取后再核对版本，变化则拒绝。cache 最多 64 个路径，不写文件。required env 按原始字符串缓存解析结果，不因同样内容反复 parse。完整配置与 isolation 数据均被冻结。

Host 通过已有启动环境 `PI_PROCESSES_SUPERVISOR_EXECUTION_ISOLATION` 把 `{version:1,policy,required}` JSON 快照传给独立 Supervisor。Supervisor 在 ready 前独立严格校验，核对实际继承的 required 声明；不存在动态 import、外部 function、模块路径或晚加载授权 callback。command/shell probe 环境删除这份 bootstrap、Core Supervisor 私有键、`BUN_BE_BUN`、required 声明，以及策略声明的精确键。matcher 仍使用可信 helper path，不把 command 环境反用于 helper。

## Launcher 接入前置条件

Core 不维护外部 owner/broker/collaboration 的专用 denylist，也不按 env key 名称猜测运行身份。未声明通用 isolation 的 launcher 不会自动剥离这些专用键；需要隔离时，launcher 必须在 Pi 启动前写好匹配的可信 agentDir 策略，并设置 required 声明，不能依赖 extension 晚加载补授权。除 Core 自己的 bootstrap/private key、`BUN_BE_BUN`、required 声明和 `removeEnv` 指定的精确键外，普通 command 环境保持原样。

外部启动器若提供数据转换函数，函数只产生 `execution.isolation` 配置片段和 required 声明数据，不意味着已应用配置或建立执行隔离。launcher 负责在启动 Pi 前应用数据；owner 必须使用 **该 Pi 进程解析后的 agentDir**，不能沿用 daemon 自己推测的路径。Core 不 import 具体环境实现；外部扩展先加载、后加载或不加载都不会授予执行权限，也不接受动态授权 callback。

缺 isolation 的既有 managed 配置会拒绝新 start。更新配置时须保留所需 `managed` 和可信 `helperRuntime`，补全 isolation，并由 launcher 提供匹配的 required 声明；Core 不自动改写配置，不读取或复制其他用户数据。

## Deadline 与终结

`process start.timeout` 为正整数秒。普通配置可以省略并无限期运行，不受示例中的 7200 秒上限约束；转换后的毫秒必须为 safe integer。只有 `start` 接受 timeout，`configure` 等其他 action 不能设置或续期。managed tool schema 和执行校验共同要求 timeout 并核实受管上限。

Supervisor 成功 spawn 时确定 `startedAt`、`timeoutMs` 和展示用 UTC `deadlineAt`；starting 请求先带 `timeoutMs`，`deadlineAt=null`。Supervisor 独自用单调时钟计时，Host reload、状态重发和系统时钟调整都不会续期；超长 timeout 分段等待。

到点先向整个 command group 发 SIGTERM，5 秒后组仍存在就发 SIGKILL。宽限内退出也记 `failed`、`cause=timeout` 和 `timeoutMs`，与自然退出共用一次终结门禁。自然退出若在 deadline 前已开始 terminalization，后续 group 收敛即使跨过 deadline，也保留 natural 分类。显式 stop 保留原 grace，但不能延后 deadline 清理。matcher/protocol timeout 不是 command timeout。

`managed.terminalWake=required` 把每个退出/超时送入已有 mailbox turn lane；模型的 ignore/context、detached 或已经满足的 watch wait 都不能取消它。它不另建 wake 队列，不绕过 abort/closing fence、mailbox pause/request permit 或 Task admission；完整投递和 settlement 见 [Mailbox 合同](MAILBOX.md#受管-terminal-wake-与状态投影)。

## Reload 与 scope cleanup

普通配置下，process 可在同一 Pi session 内跨 extension `/reload` 存活，并沿用原 readiness 流程。managed/isolated scope 不 reclaim 旧 Host，不能让新 authority 继续使用旧 Supervisor；consumer 也不能把旧 generation 的 release 套到新 generation。session scope 结束、package 被移除或未被 reclaim、Pi 退出时清理相应进程。Side shutdown（包括 reload）只清理自己的 scope，Main 和其他 child 不受影响。

## Supervisor 失联后的 containment

Supervisor 死掉时，Host 关闭 pipe，对仍标记 live 的 ACKed PGID 执行 TERM→1 秒→KILL，并等 Supervisor 退出。收敛确认后，Host 把这些 record 转成 `crashed`，`exitCode` 与 `signal` 保持 null，terminal cause 为 `runtime-contained`：containment 只证明 group 已消失，不证明 command 退出状态。

Host 在 disposal 开始就设置 `disposed=true`，所以另用只读 containment 状态 `active | pending | failed | contained` 表示清理结果。未收敛的 group 保持 live，Host 留在 `cleanup-incomplete` quarantine；cleanup 解决前拒绝 process 调用，不能把未知清理结果当作 closed。界面的故障展示见[宿主与界面合同](PI_HOST_DEPENDENCIES.md#界面与故障展示)。

恢复只发生在同一 active session 的下一次显式 process tool 调用：原子替换 Host/binding/UI 并创建 fresh generation，不重跑失败命令。`/ps` 不触发恢复。containment 之后到达的 `before_agent_start` / `turn_end` 由 stale notification coordinator 安静跳过，不上报 broker disposal。

## 遗留 log root 的启动清理

每个 Supervisor 在 `os.tmpdir()` 下独占一个 `pi-processes-<Pi PID>-<nonce>` private root。正常 scope cleanup 删除自己的 root；Pi 被 SIGKILL 或机器掉电时可能留下它。Main extension 的 `session_start` 在绑定 Host 后安排一次 pass，只删除 owner 已确认死亡的遗留 root；child runtime 不做清理。

pass 在 `setImmediate` 之后运行，不阻塞 session_start 或 first frame；每个 Pi process 只跑一次，没有 timer、重复轮询或新配置项。一次最多处理 64 个 root；500 ms 是开始下一个 root 前检查的 soft admission budget，不是硬上限，枚举 base 和已开始的文件操作可能超出预算。未开始检查的 root 留到下一次启动。

存活判断只用 `process.kill(pid, 0)`：`supervisor.json` 中的 Pi PID 与 Supervisor PID 都抛 `ESRCH` 才算死亡。EPERM、调用成功（包括 PID 被复用）或其他 error 都保留 root。删除还要求目录名、ownership、mode `0700`、封闭 layout（只有 `supervisor.json` 与 `records/`，records 中只有已知 `.jsonl` / `.index` 文件）、marker 中 nonce/PID 全部自洽，删除前再次核对身份。任一条件不成立就跳过，只记一条 skip 分类。pass 不发信号、不读 log 内容，也不删除当前 Pi 自己的 root。

`PI_PROCESSES_DEBUG=1` 把 pass 汇总（`scanned` / `inspected` / `removed` / `deferred` / 各 skip 分类）写一行 JSON 到 stderr。root 创建和扫描都用 `os.tmpdir()`，遵守平台 `TMPDIR` 等标准环境变量，没有插件专用扫描路径开关。测试子进程用独立 `TMPDIR`，使创建与清理指向同一隔离 base。
