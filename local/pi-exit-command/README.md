# pi-exit-command

## 用途

`/exit` 把「回到当前目录、用同样的启动参数接着当前会话重开 Pi」的 shell 命令复制到剪贴板，然后正常退出。临时会话（没有 session 文件）或复制失败时只提示错误，不退出。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

Pi 版本见[根支持说明](../../README.md#支持说明)。

## 用法

在输入框执行 `/exit`，剪贴板得到形如下面的命令：

```sh
cd -- /work/repo && pi --model sonnet --session /home/u/.pi/sessions/2025_ab.jsonl
```

粘贴执行即回到同一目录、同一启动参数、同一会话。`--continue`、`--resume`、`--session`、`--session-id`、`--fork`、`--mode`、`--export`、`--no-session`、`--help`、`--version` 不重放；`--print` 的提示词、`--list-models` 的搜索词、位置消息与 `@文件` 也不重放。其余启动参数原样保留，因此也包括 `--api-key` 这类凭据——命令会留在剪贴板历史里。完整规则见 [docs/restart-command.md](docs/restart-command.md)。

重开依赖 `pi` 在 `PATH` 上，与日常启动方式一致。stock Pi 1.5 自带 `/quit`、没有 `/exit`，两者不冲突；若将来宿主新增同名内置命令，内置命令优先，本包需要改名。

## 配置与命令

只有一个 `/exit` 命令，没有配置项。

## 可选协作与降级

独立使用，不依赖其他插件或共享库。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-exit-command
npm test -w pi-exit-command
npm run check:host -w pi-exit-command
```

单元测试不碰真实剪贴板，也不退出进程；`check:host` 用真实 Pi 验证命令注册和临时会话报错路径，不用真实 provider。

快速升级的本包宿主冒烟入口为 `npm run check:smoke -w pi-exit-command`；范围与放弃的保障见[升级规则](../../CONTRIBUTING.md#升级-pi)。

## 文档

- [docs/restart-command.md](docs/restart-command.md)：参数保留与丢弃规则、argv 解析、失败路径。
