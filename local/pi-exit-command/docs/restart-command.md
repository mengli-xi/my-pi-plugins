# 重启命令的生成规则

`/exit` 只做两件事：拼一条 shell 命令复制到剪贴板，然后调用 `ctx.shutdown()`。命令形如：

```sh
cd -- <启动目录> && pi <保留的启动参数...> --session <当前 session 文件>
```

每一段都用单引号转义；只含 `A-Za-z0-9_@%+=:,./-` 的值不加引号。命令名固定为 `pi`，不猜测当前可执行文件路径，因此 `pi` 必须在 `PATH` 上。

## argv 解析

`process.argv` 的前缀按启动方式去掉：

| 启动方式 | `execPath` | 跳过的前缀 |
| --- | --- | --- |
| `node <cli.js> ...` / `bun <cli.js> ...` | `node`、`bun`（含 `.exe`） | 运行时与脚本两段 |
| bun 编译版 | 任意可执行文件 | 可执行文件与 `/$bunfs/root/` 入口两段 |
| 其他可执行文件 | 例如 `pi` | 只跳过可执行文件 |

## 参数分类

分类与 Pi 1.5 的 CLI 解析（`@earendil-works/pi-coding-agent` 的 `dist/cli/args.js`）逐项对应。升级 Pi 后要重新核对这张表。

### 整条丢弃

`--continue`/`-c`、`--resume`/`-r`、`--no-session`、`--help`/`-h`、`--version`/`-v`。

它们要么指向别的会话，要么本次启动就会退出，重放后都回不到当前会话。

### 连带值一起丢弃

`--session`、`--session-id`、`--fork`、`--mode`、`--export`。

`--session` 由生成的命令用当前 session 文件补在末尾；`--mode`、`--export` 是另一次输出；`--session-id`、`--fork` 会换掉当前会话。`--export` 后面的第二个位置参数（导出目标）按普通位置参数丢掉。

### 保留并带上值

`--provider`、`--model`、`--api-key`、`--system-prompt`、`--append-system-prompt`、`--name`/`-n`、`--session-dir`、`--models`、`--tools`/`-t`、`--exclude-tools`/`-xt`、`--thinking`、`--extension`/`-e`、`--skill`、`--prompt-template`、`--theme`、`--use-theme`、`--tui-mode`。

缺值时报错并放弃退出。`--api-key` 等凭据会原样进入命令和剪贴板历史。

### 保留，不带值

`--no-tools`/`-nt`、`--no-builtin-tools`/`-nbt`、`--no-extensions`/`-ne`、`--no-mcp`、`--no-skills`/`-ns`、`--no-prompt-templates`/`-np`、`--no-themes`、`--no-context-files`/`-nc`、`--verbose`、`--approve`/`-a`、`--no-approve`/`-na`、`--offline`。

### 特殊处理

- `--print`/`-p`：丢掉开关和它的提示词，重开必须是交互会话。提示词是否跟在后面，按 Pi 的规则判断（不以 `@` 开头、不以 `-` 开头，或以 `---` 开头）。
- `--list-models`：丢掉开关和可选的搜索词。
- `--`：之后全是消息与 `@文件`，整段丢弃。
- 其他 `--xxx`：当作扩展注册的 flag，原样保留；不带 `=` 时按 Pi 的未知 flag 规则把紧随的非 `-`、非 `@` 参数当作它的值。
- 其他 `-x`：抛错。Pi 对未知短参数本身也报错，不猜它的语义。

位置消息和 `@文件` 已经提交给当前会话，重放会多跑一轮模型，因此一律丢弃。

## 失败路径

| 情况 | 结果 |
| --- | --- |
| `ctx.sessionManager.getSessionFile()` 为空（临时会话、未保存） | `ui.notify(..., "error")`，不写剪贴板，不退出 |
| 参数解析失败（缺值、未知短参数） | 同上，提示里带具体参数 |
| 剪贴板写入失败 | 同上，提示里带失败原因 |
| 成功 | 写剪贴板后 `ctx.shutdown()` |

所有失败都在退出前返回，用户仍留在当前 Pi 进程和会话里。

## 测试边界

单元测试直接调用 `buildRestartCommand` 与 `createExitHandler`，用假的 `writeClipboard`、`sessionManager`、`shutdown`，不碰真实剪贴板和进程。`check:host` 用真实 Pi 1.5 加载本包，检查 `/exit` 注册为扩展命令、临时会话下 `/exit` 产生错误提示且宿主继续存活。
