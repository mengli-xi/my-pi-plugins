---
name: pi-processes
description: 用 process tool 管理长期运行的命令，适用于 dev server、watcher、build、本地 service 和日志条件等待；普通 scope 的进程可跨 Pi extension reload 存活。
---

# pi-processes

当 agent 继续工作期间命令必须持续运行时，使用 `process` tool。不要使用 `&`、`nohup`、`disown`、`setsid` 或 daemonizing command 等 shell background escape pattern。

普通配置下，supervised process 可在同一 Pi session 内跨 extension `/reload` 存活；managed/isolated scope 不 reclaim 旧 Host。session scope 结束、package 被移除或未被 reclaim、Pi 退出时，会清理相应进程。

## 操作

该 tool 有七个 action：

- `start`：启动一个 supervised process。
- `list`：列出 process record。
- `logs`：读取有界的 retained log。
- `input`：写入 stdin byte 或发送 EOF。
- `configure`：重命名 live process，或修改其 kind、watch、continuation 或 notification policy。
- `stop`：停止一个 live process group。
- `clear`：清除 terminal record 及其 retained log。

process name 必填，在 live process 中必须唯一，且最多 16 个 terminal column。优先使用 `web-dev`、`api` 或 `vitest` 等简洁 identity。

角色明确时应显式设置 `kind`：普通工作使用 `process`（默认），主要观察 log condition 的 process 使用 `monitor`，长期 server 或 development service 使用 `service`。`configure` 可在不重启 process 的情况下改变 kind。

## 启动与 continuation

`continuation` 省略时默认 detached。依赖关系明确时应显式设置，避免模型把“tool 立即返回”误解成“命令已完成”。

有用工作可立即继续时使用 detached：

```json
{
  "action": "start",
  "name": "web-dev",
  "kind": "service",
  "command": "pnpm dev",
  "cwd": "/path/to/project",
  "continuation": { "mode": "detached" }
}
```

下一步依赖一次性 command 完成时，等待 exit：

```json
{
  "action": "start",
  "name": "tests",
  "command": "npm test",
  "continuation": { "mode": "wait", "until": { "kind": "exit" } }
}
```

下一步依赖 ready 或 milestone log line 时，使用稳定的 watch key：

```json
{
  "action": "start",
  "name": "api",
  "command": "pnpm dev:api",
  "watches": [
    {
      "key": "ready",
      "pattern": "Server listening",
      "mode": "literal",
      "stream": "stdout",
      "repeat": false,
      "attention": "turn"
    }
  ],
  "continuation": {
    "mode": "wait",
    "until": { "kind": "watch", "key": "ready" }
  }
}
```

`start.timeout` 可选，单位为正整数秒；普通配置省略时无限期，受管 agentDir 策略要求它时必须填写并遵守配置上限。例如一次测试可写 `"timeout": 600`。Supervisor 用单调时钟计时，reload 不续期；到点向整个 command group 发 TERM，5 秒后仍存在就 KILL，终态为 `failed + cause=timeout`，宽限内退出也算 timeout。其他 action 不接受 timeout，不能续期。

`managed.terminalWake=required` 时，退出/超时仍必须进入 turn lane，不能用 ignore/context、detached 或已满足的 watch 压掉；abort/closing fence 与 child Task admission 仍生效。launcher 若需要环境隔离，必须在启动前声明匹配的 required isolation 与可信 agentDir `removeEnv` 策略，Core 不自动识别或剥离外部专用键。完整设置见[执行合同](../../docs/MANAGED_EXECUTION.md)。

`continuation` 描述 dependent agent work 何时可恢复。`start` 在 Supervisor 确认 process 后立即返回；不要 sleep 或 poll。

## 监视规则

一个 watch 包含稳定的 process-scoped `key`、literal 或 regex `pattern`、stream、repeat policy 和 attention level。

- 优先使用 literal match。
- 仅在必要时使用 regex。
- pattern 要具体。
- readiness 使用 `repeat: false`。
- 仅当 agent 需要响应时使用 `attention: "turn"`；信息性 event 使用 `context` 或 `ignore`。

watch 只匹配 armed 之后产生的 log。可在不重启 process 的情况下更新：

```json
{
  "action": "configure",
  "target": "api",
  "watchUpdate": {
    "operation": "upsert",
    "items": [
      {
        "key": "port-error",
        "pattern": "EADDRINUSE",
        "stream": "stderr",
        "repeat": true,
        "attention": "turn"
      }
    ]
  }
}
```

其他 watch update：

```json
{ "action": "configure", "target": "api", "watchUpdate": { "operation": "remove", "keys": ["ready"] } }
```

```json
{ "action": "configure", "target": "api", "watchUpdate": { "operation": "clear" } }
```

## 列表与日志

`list.states` 只接受 `starting | running | stopping | succeeded | failed | stopped | killed | crashed`；不存在 `exited`、`completed` 或 `terminal` 聚合值。`list.sort` 只接受 `started-desc | started-asc | name-asc | state`；不存在 `recent`。若不需要筛选/排序，省略这些字段。

`notify` 必须是 object；每个 `onSuccess | onFailure | onKilled | onCrash` 值只接受 `turn | context | ignore`（`configure` 还可用 `null` 恢复默认）。不要把 `notify` 写成 boolean、string 或任意消息文本。

启动前先检查是否存在 live process，避免重复：

```json
{ "action": "list", "states": ["starting", "running", "stopping"] }
```

读取有界 log，而不是 poll：

```json
{
  "action": "logs",
  "target": "api",
  "stream": "stderr",
  "tailLines": 100,
  "pattern": "error",
  "mode": "literal"
}
```

第一页 log 读取当前 retained snapshot。只能使用返回的 cursor 继续；log revision 变化后，stale cursor 会 fail closed。

## 输入

写入 stdin data 或发送 EOF：

```json
{ "action": "input", "target": "worker", "data": "reload\n" }
```

```json
{ "action": "input", "target": "worker", "eof": true }
```

process 使用 pipe，不使用 PTY。不要用该 tool 运行 `vim` 或交互式 TUI program 等 full-screen terminal application。

## 停止与清理

显式停止已过时的 live process：

```json
{ "action": "stop", "target": "api" }
```

log 不再有用时清除 terminal record：

```json
{ "action": "clear" }
```

`clear` 绝不会移除 live process。

## 界面

使用 `/ps` 打开统一的 process manager 与 log view。editor 上方的一行 strip 右对齐显示 muted `ps · name · name` 导航；statusline 另按 `process | monitor | service` 聚合 live role。terminal outcome 会在 strip 保留 5 秒，随后隐藏但不删除 retained record。点击 strip name 直接打开其 log，因此 Esc 会关闭 manager；从 `/ps` list 进入 log 时，Esc 会先回到 list。真实 command deadline 显示为 `timeout`，终态仍是 `failed`；不注册其他 `/ps:*` command。
