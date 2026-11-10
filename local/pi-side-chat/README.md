# pi-side-chat

在 Main 旁边打开独立、临时的 SDK 对话，或用 BTW 问一个不需要工具的问题。Side 与 Main 同进程，没有独立 child process 或 PTY 后端。

## 加载

需要原版 Pi 1.5.0，在仓库根安装 workspace 依赖后直接加载 TypeScript：

```sh
bun install --frozen-lockfile
pi -e "$PWD/local/pi-side-chat"
```

本包无 build 或 dist。Session Runtime、Runtime Contracts 和 UIKit 是共享库依赖；CC Style、Bash Timeout、Processes、Search 与外部 provider 通过明确的 factory/协议协作，不直接 import 这些插件的生产源码。配置或源码改变后新开 Pi process。

## 命令与交互

| 入口 | 行为 |
| --- | --- |
| `/side`、`Alt+/` | 打开或返回已有 Side |
| `/side destroy` | 取消工作、完成 scope 清理，再删除 Side 私有文件 |
| `/btw <问题>` | 无工具旁问；提交即打开 pending 面板，答案返回后原地更新 |
| `/btw` | 浏览至多 20 条已完成答案 |
| `/btw cancel` | 取消当前 BTW 请求，不产生成功通知 |

Main 可在后台继续执行。普通返回只关闭 Side view，保留 Side 会话与草稿；Main 的 new/resume/fork/clone/reload/quit 都销毁 Side。Side 占前台时，BTW 等 Main 恢复后再打开，不争抢 stdin。用户主动关闭 BTW 面板后，请求仍可完成，但答案到达不强制重开；可再次 `/btw` 查看。

Side 内可用 `/side`、`/exit`、`/quit` 返回 Main，以及 `/model [model]`、`/copy`、`/session`、`/compact [instructions]`、`/hotkeys`、`/changelog`、`/help`。Side 不接受 Main 的 session/process 命令、`/subagents` 或任意 extension slash command。

Side 忙时 `Ctrl+C` 中断，空闲时返回。非空输入中的 `Ctrl+D` 保持 forward delete；空输入需在四秒内按两次才销毁，编辑/Escape/到期取消确认。`Ctrl+Z` 禁用。外部 editor 使用临时 terminal yield，shutdown 等它收口。

## 上下文、授权与成本

Side 优先继承 Main 最近真正发给模型的请求与稳定 tail，不继承部分 assistant 或未闭合 tool batch。capture 缺失或过期时要求一次新 Main turn，或明确接受原生记录，不静默恢复已丢弃的旧历史。Side 模型、effort、默认设置与草稿不修改 Main 或磁盘设置。

Side/BTW 都会调用选定 provider，发送继承上下文并产生独立请求与费用；不是纯本地功能，也没有额外的固定服务端。BTW 不提供工具、不写入 Main transcript。OpenAI Responses 可复用 `prompt_cache_key`，但 session/request ID 独立；是否命中远端 cache 只看 provider usage，不作保证。

Side 工具只从 Main 的 active tools 中投影到受审计的 catalog。Main 启用必填 timeout 的 bash 时，Side 必须使用同一 required-only factory 与定义指纹，不能回退宽松 builtin。外部 provider 必须有独立 `pi-side-chat` target 和实际 agentDir 下的批准；Subagents 的声明或批准不外溢。缺少必要执行 factory、模型授权或发生漂移时拒绝创建 Side。

没有 CC Style 时使用原生 Pi 界面；已有但非法/漂移或携带执行能力的 presentation descriptor 仍拒绝。状态栏贡献无人接收时用原生状态，不阻断 Side/BTW。

Side 共享 Main 的文件系统、网络与 credentials，没有 sandbox 或跨会话文件锁；同时编辑文件可能冲突。销毁是 cooperative cleanup，不能硬杀任意 JavaScript。私有会话在实际 agentDir 下，销毁后不支持跨进程重开。

## 配置

从实际 `getAgentDir()`（遵守 `PI_CODING_AGENT_DIR`）下的 `extensions/pi-side-chat/config.json` 读取：

```json
{ "shortcut": "alt+/" }
```

唯一后端是同进程 SDK。已设置的 `PI_SIDE_BACKEND`（包括空值）、`defaultBackend`、`extensionCommands` 会禁用 Side/BTW 并明确报错；其他未知字段沿用忽略行为。无效配置不阻止 Main 启动。修改配置后重启 Pi。

## 验证与使用回归

```sh
npm run typecheck -w pi-side-chat
npm test -w pi-side-chat
PI_TEST_EXECUTABLE=/path/to/stock-pi-1.5.0 npm run check-internals -w pi-side-chat
PI_TEST_EXECUTABLE=/path/to/stock-pi-1.5.0 npm run test:ui -w pi-side-chat
npm run test:integration
PI_TEST_EXECUTABLE=/path/to/stock-pi-1.5.0 npm run test:integration:side-chat
```

测试使用临时 HOME/profile/session 和 faux provider。跨插件用例归[根 integration](../../integration/README.md)，不能用单元测试冒充真实终端、provider/cache 或完整 profile 验收。

日常可在临时会话顺手检查：

- Main 工作时执行 `/btw` 提问，立即看到 pending，答案原地出现；关闭后不抢回焦点，取消/切换 session 不残留旧答案。
- 打开 Side，修改草稿、模型与 effort，再返回 Main：原 editor/draft/settings 不变，重新进入保留 Side 状态。
- 不加载 CC 仍能进入原生 Side；加载 CC 后显示独立 presentation，但不新增执行权限。
- Side 运行 Process 时先普通返回，再 destroy：前者继续保留 scope，后者先持久取消 pending 再删目录。取消失败应保留目录与可重试 ownership，不创建 replacement。
- Side 压缩后继续对话；`/copy` 不复制继承的 Main 答案。BTW 宽窄布局、滚动、未读标记和 Escape 行为保持独立。

## 合同文档

- [SDK_SESSION.md](docs/SDK_SESSION.md)：capture、模型/工具授权、Main/Side/view ownership 与销毁顺序。
- [BTW.md](docs/BTW.md)：pending 面板、前台仲裁、取消、历史与请求边界。
- [PI_HOST_DEPENDENCIES.md](docs/PI_HOST_DEPENDENCIES.md)：Pi 1.5 公开接口、两项 instance-only probe 与 stock host 降级。
