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

克隆仓库，在仓库根安装依赖：

```sh
git clone https://github.com/mengli-xi/my-pi-plugins.git
cd my-pi-plugins
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
    "/path/to/my-pi-plugins/local/pi-todo",
    "/path/to/my-pi-plugins/fork/pi-goal"
  ]
}
```

相对路径以该 settings 文件所在目录为基准。Pi 只加载配置中的包，不会启用整个仓库。

批量安装可用[统一安装脚本](scripts/install-plugins.mjs)，先预览再执行：

```sh
npm run plugins:install -- --all --dry-run
npm run plugins:install -- --all
# 包含开发/示例插件：
npm run plugins:install -- --all --include-dev
# 只安装指定插件（支持包名、目录名或仓库相对目录）：
npm run plugins:install -- pi-todo pi-goal
```

脚本要求 PATH 中的全局 Pi 与[根要求](#要求)版本一致，查找时排除本仓 `node_modules/.bin`，避免 `npm run` 注入的开发版遮住日常宿主；可用 `--pi /absolute/path/to/pi` 指定 CLI，相对 CLI 路径以仓库根解析。它先在根执行 `bun install --frozen-lockfile`，构建选中插件中声明了 `build` 的包，全部成功后逐个执行 `pi install`。`--dry-run` 不执行命令或写配置，运行时版本检查也只展示。

安装写入个人配置，遵守 `PI_CODING_AGENT_DIR`；不安装共享库为插件，不升级 Pi 或拉取仓库。重复运行沿用 Pi 的路径去重及已有资源过滤，已禁用插件不会被强制启用；`--all` 不移除之前装过的开发插件。任一步失败立即停止，已经成功的安装保留，修复后可以重跑。更新仓库后可再次运行以重建并补装插件，最后启动新 Pi 进程。

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
