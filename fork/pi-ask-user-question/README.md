# pi-ask-user-question

给 Pi 注册 `ask_user_question`。模型一次提出 1–4 个问题，用户选择选项、输入自己的答案，或先讨论、要求解释；工具把结果作为结构化数据交回模型。本 Fork 以 `@juicesharp/rpiv-ask-user-question` 2.15.0 为上游基线。

## 加载与使用

在 Pi 的 package 配置中启用本包目录，重启 Pi。Pi 直接加载 TypeScript 源码，不需要 build 或 `dist/`。使用仓库根目录声明的 Node 与 Pi 开发环境；修改后用新 process 验证，不用 `/reload` 代替重启。

模型调用时必须提供 `context`，先用几句话说明用户正在做什么、选择会改变什么，再给当前任务的具体例子。每题写 2–4 个选项及各自的含义或取舍；界面自动补上自定义回答和适用的控制行，模型不要手写这些行。

- 终端中默认在 transcript 下方的 editor 区域打开问卷，可继续滚动聊天记录；空间不足时问卷内部滚动，冲突时回退 overlay。
- 每题都有 `Type something.`；多选能同时提交勾选项和自定义文本。
- 单选另有 `Chat about this` 和 `Explain More`：前者讨论疑虑，后者要求模型立即用人话解释，不把它们当成业务答案或取消。
- 可以逐题加 note；多题的 Submit tab 可以加 `globalNote`，并标出尚未回答的问题。
- RPC/ACP 走宿主原生 `select`/`input`；没有 UI 的运行不向模型提供这个工具。
- 会话历史使用 Pi 原生工具回执显示问题摘要和答案；模型仍收到完整的结果 envelope。

本包不自行请求模型、不联网，也没有 slash command。

## 配置与依赖

配置可选，默认即可使用。包只读官方 XDG/legacy 配置位置，不创建或修改文件，也不搬到 Pi 的 agent/config 目录。完整路径、键值和缓存边界见 [配置](docs/configuration.md)。

运行时依赖共享库 `@juicesharp/rpiv-config` `^2.15.0`。`@juicesharp/rpiv-i18n` SDK 可选：存在时共享 locale，不存在时用英文；开发装配可以安装 SDK，但不应因此默认启用它的 extension。它提供的 `/languages` 也不由本包注册。

## 可选协作与降级

本包单独启用即可工作，不 import 其他插件。`pi-perf`、tmux supervisor 等只可以作为可选消费者，通过事件观察或驱动问卷；缺少它们不影响提问、作答和结束等待。

上游 `rpiv:ask-user:*` 无版本后缀频道按 **legacy 兼容协议** 保留原名，不因目录迁移改名。它们只面向可信同进程参与方；本包不提供远程连接、认证或网络转发。完整 payload、`toolCallId` 关联和 answer verdict 见 [事件协议](docs/events.md)。

## 验证与排障

按 [日常回归](docs/regression-cases.md) 检查问卷、控制草稿、滚动、取消、RPC 和缺少协作者的场景。自动验证命令与测试归属见该文档；这里不保存运行记录。

UI 加载失败不代表用户拒答：模型应改用普通聊天提问。若运行期间依赖被替换，先修复安装，再重启 Pi。`Ctrl+]` 在当前键盘上打不出时，可以改 `collapseKey`；详见下列文档。

## 文档

- [工具参数与结果](docs/tool-schema.md)：`context`、校验、`prepareArguments`、答案 envelope 与原生回执。
- [键盘与布局](docs/keyboard.md)：digits、notes、Kitty、控制草稿、inline/overlay、折叠与预览。
- [配置](docs/configuration.md)：XDG/legacy 查找、只读策略、快捷键、guidance 与生效时间。
- [宿主与降级](docs/hosts.md)：TTY、RPC/ACP、无 UI、工具选择和失败边界。
- [事件协议](docs/events.md)：legacy prompt/blocked/answer/answer-result 与信任边界。
- [本地化](docs/localization.md)：optional SDK、共享 locale 与英文回退。
- [加载与性能边界](docs/startup-performance.md)：禁 prewarm、cold load 合并和 strip-only。
- [日常回归](docs/regression-cases.md)：维护时需要重复检查的场景，不是验收流水。
- [本地 patch 意图](LOCAL_PATCHES.md)：维护 Fork 时需要保留的差异及取舍。

## License

MIT，见 [LICENSE](LICENSE)。
