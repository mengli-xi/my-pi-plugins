# Pi 插件集

这是一组可按需启用的 [Pi](https://pi.dev) 插件，用来调整终端界面、管理会话、委派任务和接入工具。每个插件都能单独启用，不必全装；用法和命令见各包 README。

## 插件

### 界面

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-claude-style](local/pi-claude-style/README.md) | 插件 | 提供 Claude Code 风格的工具展示、编辑器和状态栏。 |
| [pi-terminal-focus](local/pi-terminal-focus/README.md) | 插件 | 终端失焦时隐藏编辑器光标，聚焦后恢复。 |

### 管理与诊断

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-package-manager](local/pi-package-manager/README.md) | 插件 | 用 `/plugins` 查看、启停和更新已配置的包。 |
| [pi-perf](local/pi-perf/README.md) | 插件 | 记录性能趋势，查看耗时并生成离线报告。 |

### 会话与上下文

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-cc-memory](local/pi-cc-memory/README.md) | 插件 | 按项目保存记忆，让后续会话继续使用。 |
| [pi-session-compact](local/pi-session-compact/README.md) | 插件 | 压缩长会话，保留用户原话，并能检索原文。 |
| [pi-session-naming](local/pi-session-naming/README.md) | 插件 | 会话空闲后自动生成标题，会额外请求模型。 |
| [pi-rewind](local/pi-rewind/README.md) | 插件 | 裁剪会话并保留恢复归档，不撤销文件改动。 |
| [pi-side-chat](local/pi-side-chat/README.md) | 插件 | 在主会话旁开临时对话，或用 `/btw` 顺手提问。 |
| [pi-skills](local/pi-skills/README.md) | 插件 | 输入 `$` 选择技能，把完整规则加入请求。 |
| [pi-exit-command](local/pi-exit-command/README.md) | 插件 | 用 `/exit` 复制重开当前会话的命令后退出。 |

### 后台任务

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-subagents](local/pi-subagents/README.md) | 插件 | 把任务交给后台 Agent，查看进展并接收结果。 |
| [pi-processes](local/pi-processes/README.md) | 插件 | 监督后台命令，查看日志并接收退出通知。 |
| [pi-scheduler](local/pi-scheduler/README.md) | 插件 | 创建持久定时任务，Pi 退出后仍可调度。 |
| [pi-goal](fork/pi-goal/README.md) | Fork 插件 | 持续推进目标，支持预算、暂停和完成检查。 |
| [pi-todo](local/pi-todo/README.md) | 插件 | 让模型维护待办，用 `/todos` 查看进度。 |

### 模型

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-effort](local/pi-effort/README.md) | 插件 | 用 `/effort` 滑杆调整模型的推理档位。 |
| [pi-fast](local/pi-fast/README.md) | 插件 | 为 OpenAI Codex 请求切换优先处理模式。 |
| [pi-model-capacity](local/pi-model-capacity/README.md) | 插件 | 用 `/usage` 查看支持的服务商容量、订阅用量和余额。 |
| [pi-model-prompts](local/pi-model-prompts/README.md) | 插件 | 按模型选择规则和提示词，不必每次重填。 |

### 工具

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-ask-user-question](fork/pi-ask-user-question/README.md) | Fork 插件 | 让模型用问卷提问，你可以选项作答、补充或先讨论。 |
| [pi-bash-timeout](local/pi-bash-timeout/README.md) | 插件 | 要求模型执行 bash 时明确填写超时秒数。 |
| [pi-mcp-adapter](fork/pi-mcp-adapter/README.md) | Fork 插件 | 按需连接 MCP 服务，发现和调用它们的工具。 |
| [pi-native-search](fork/pi-native-search/README.md) | Fork 插件 | 搜索网页和抓取正文，原生搜索不可用时回退 DuckDuckGo。 |

### 共享库与开发插件

日常使用不用单独安装或启用这些包。共享库随依赖安装；开发插件只用于调试组件。

| 包 | 类型 | 用途 |
| --- | --- | --- |
| [pi-li-uikit](local/pi-li-uikit/README.md) | 共享库 | 提供面板、选择器、鼠标和剪贴板组件。 |
| [pi-runtime-contracts](local/pi-runtime-contracts/README.md) | 共享库 | 定义插件之间共用的数据与协作约定。 |
| [pi-session-inject](local/pi-session-inject/README.md) | 共享库 | 保存并投递后台消息。 |
| [pi-session-runtime](local/pi-session-runtime/README.md) | 共享库 | 装配子会话、传递上下文并打开子会话视图。 |
| [pi-li-uikit-gallery](local/pi-li-uikit-gallery/README.md) | 开发插件 | 交互式预览界面组件。 |

## 要求

支持 **Pi 1.5.2**。需要 Node.js 22.19+；安装仓库依赖和构建需要 Bun 1.3+。

下面 7 个插件要先用 Bun 构建才能用：pi-claude-style、pi-session-naming、pi-subagents、pi-processes、pi-goal、pi-mcp-adapter、pi-scheduler。其他包直接加载源码，无需构建；没有构建步骤的插件运行时不要求 Bun。

## 安装与加载

把 `<仓库地址>` 换成实际地址，在仓库根安装依赖：

```sh
git clone <仓库地址> pi-packages
cd pi-packages
bun install --frozen-lockfile
```

只构建你要用的插件，构建过程需要 Bun：

```sh
npm run build -w pi-claude-style
npm run build -w pi-session-naming
npm run build -w pi-subagents
npm run build -w pi-processes
npm run build -w @narumitw/pi-goal
npm run build -w pi-mcp-adapter
npm run build -w pi-scheduler
```

从本地路径安装单个插件，然后启动 Pi：

```sh
pi install "$PWD/local/pi-todo"
pi
```

`pi install` 写入个人配置；加 `--local` 写入当前项目的 `.pi/settings.json`，项目受信后才加载。Pi 直接加载本地目录，不复制包，也不自动构建。请保留整个仓库，不要只拷走单个包目录。

也可手动把插件绝对路径加入 Pi 配置目录的 `settings.json`：

```json
{
  "packages": [
    "/path/to/pi-packages/local/pi-todo",
    "/path/to/pi-packages/fork/pi-goal"
  ]
}
```

相对路径以该 settings 文件所在目录为基准。Pi 只加载配置中的包，不会启用整个仓库。

只想试一次，不保存配置：

```sh
pi -e "$PWD/local/pi-todo"
```

## 更新

在仓库根运行：

```sh
git pull
bun install --frozen-lockfile
```

重新运行已启用插件的构建命令，再新开 Pi 进程生效。`/reload` 不能代替重建和重启。

## 支持平台与已知限制

支持 macOS 和 Linux。Linux 基线为 Ubuntu 24.04、x86_64 glibc、Node.js 24、Bun 1.3+ 和本地 ext4。

- Linux 上没有 Secret Service（如 gnome-keyring）时，pi-mcp-adapter 的 OAuth 凭据存进内核 keyring，只在内存里，系统重启后要重新登录。
- 没有可用的剪贴板命令时，复制改发终端 OSC 52 序列，终端不支持也会显示已复制；打开图片只确认系统打开命令已启动，不确认图片真的打开了。
- pi-subagents 所在的 Pi 进程被强杀后，它启动的 bash 子进程可能短暂残留。
- pi-perf 的可选启动包装脚本依赖 zsh，插件本身不需要。

## 安全

扩展在 Pi 宿主进程里运行，拥有与宿主相同的权限。安装前请查看源码。

## 许可证

采用 [MIT 许可证](LICENSE)。`fork/` 下的包保留各自上游的 MIT 许可和版权声明。

## 贡献

请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。AI 与维护者从 [AGENTS.md](AGENTS.md) 进入协议、宿主补丁和验证说明。
