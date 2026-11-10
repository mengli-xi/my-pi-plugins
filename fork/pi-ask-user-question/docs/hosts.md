# 宿主与降级

## 环境选择

| 环境 | 模型看到什么 | 用户看到什么 |
| --- | --- | --- |
| 交互终端 | `ask_user_question` | 默认 inline 问卷，必要时 overlay fallback |
| RPC/ACP、且宿主有 UI | `ask_user_question` | 宿主原生 select/input，按题依次显示 |
| 无 UI | 工具从 active set 隐藏 | 不弹问卷 |

本工具是 `exposure: "model-only"`：模型直接调用，codemode 的 only 模式也不应把它藏进脚本；脚本不能调用它来触发阻塞交互。

## 工具选择约束

`before_agent_start` 只在无 UI 时从 active set 隐藏 `ask_user_question`，绝不自动重新加入，保持兄弟工具不变。公开 API 没有 selection revision；即使 active 列表未变，也不能证明用户没有重设权限，不能把 UI 可用当作执行授权。

同一 SDK session 从 headless 切回 UI，需由 Host/用户显式调用 `setActiveTools`；新 session 按初始 selection 正常初始化。协调应幂等，不能每轮重写相同 active set。

若没有 UI 仍收到调用，执行侧返回 `no_ui`，正文为 `Error: UI not available (running in non-interactive mode)`，不尝试打开界面。

## Terminal attention

问卷校验和 UI 检查通过、交互等待开始前，向 TTY stdout 发一次标准 BEL（`\x07`）。终端决定是声音、闪烁还是忽略。重定向或非 TTY 输出不会收到该字节；TTY-backed RPC 等待同样可收到它。

BEL 写入失败不阻止问卷，不改变 prompt/blocked 生命周期或结果；缺 UI、参数无效、TUI 加载失败不发 BEL。事件的准确关联见 [events.md](events.md)。

## 宿主已分配行高

可信 Host 若已经给问卷分配了独立区域，可在传入的 `tui.terminal` 上设置 `Symbol.for("rpiv-ask-user-question:host-allocated-rows")` 为 `true`。本包沿用这个上游无版本兼容标记，将 `terminal.rows` 视为已分配的预算，不再套用 inline 的 70% 上限，也不替 Host 决定其布局。未设置或非 `true` 时使用普通 inline/overlay 策略。

该标记只影响几何，不授予工具执行、外部答复或读取配置的权限；本包不为发现它扫描其他插件或私有存储。

## RPC/ACP

`ctx.mode === "rpc"` 直接走原生 dialog walker，不 import TUI 渲染图。较旧宿主若 custom UI 未实际挂载而返回，也尝试原生 fallback。两条路径都要求同时有 `select` 和 `input`。

每题和相关输入都显示用户可见 `context`，标题默认为 `Why this decision matters`，可随 UI 本地化。答案仍走统一 envelope，但受宿主原语限制：

- 没有 tab bar、Submit review、checkbox 和并排 preview。preview 折进标题，每项最多 600 个字符。
- 没有逐题 notes 或 global note；原生 API 没有独立 notes 字段。不要把控制请求的可选文字误称为 notes 功能对等。
- 多选用文本输入：`1,3` 选两个选项，`1,3; another color` 同时提交选项和自定义文本，只写文本就是自定义多选答案。空输入是显式空选择。不能解析为合法编号的输入按自定义文本保留，不丢掉数字后面的文字。
- 单选识别完整选项行、合法的纯编号和选项 label；其他非空回复为用户自己的文本，例如 `2 but change the title` 不能变成只选第 2 项。
- 选择 `Type something.` 后打开输入，列出题目、context 和选项说明；取消或输入空白返回选项，不取消整份问卷、不丢已有答案。
- 单选的 `Chat about this` 直接返回讨论请求；`Explain More` 打开可选原生输入，关闭该输入按空文字继续解释请求。两者都不是普通答案。控制语义见 [tool-schema.md](tool-schema.md)。
- 取消题目的选项对话框或多选输入，取消整份问卷；自定义和控制的 follow-up 有上述例外。

外部 answer 事件不接管这些原生对话框，返回 `unsupported_host`。没有 custom UI、也没有完整原生 dialogs 时返回 `no_custom_ui`，明确告诉模型用户从未看见问题，改用普通聊天提问，不当成拒答。

## 取消与等待

用户取消、完成作答和执行错误都必须结束本次等待；取消不得伪装成用户选中了默认项。Esc 关闭 notes/控制编辑器与取消整份问卷是两个层级，见 [keyboard.md](keyboard.md)。

执行 signal 取消与 UI、外部答案可能并发。维护时必须检查已取消调用能结束、等待事件被清理、后续调用还能使用，不把用户没有提交的草稿当答案。具体回归步骤见 [regression-cases.md](regression-cases.md)；这里不承诺宿主 UI 的取消帧时序或跨调用恢复草稿。

## 加载失败

| `error` | 含义 | 处理 |
| --- | --- | --- |
| `session_load_failed` | 模块无法 import | 修复安装（如有必要），重启 Pi |
| `stale_module_cache` | namespace 缺少 session class，可能是较早失败污染 loader cache | 重启 Pi |

两者都保留具体错误上下文，正文要求模型先用普通聊天提问，不视为用户拒答。本包禁用启动 prewarm；首次加载和并发边界见 [startup-performance.md](startup-performance.md)。不要在 Pi 运行中替换依赖来追求热升级。

## 独立使用

可选协作者缺失、先加载或后加载都不能使本包抛错、取消用户操作或留下等待状态。本包不调用其他插件的私有方法；它的原生回执也不要求样式插件存在。本地化 SDK 缺失回退英文，见 [localization.md](localization.md)。
