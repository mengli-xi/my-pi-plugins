# 日常回归

本页列出维护时需要重复检查的用例，不记录执行日期、通过数或审批结论。参数/结果以 [tool-schema.md](tool-schema.md) 为准，事件以 [events.md](events.md) 为准。

## 环境与自动检查

使用仓库声明的 Pi/Node 版本，新 process、隔离的 HOME/agent/cwd/XDG 配置、faux provider；不请求真实 provider，不读日常凭据，不改真实终端设置或剪贴板。包内测试只加载本包；跨插件（包括缺协作者）放根 `integration/`。不把测试命令或环境开关注册进生产 extension。

在仓库开发依赖已装配好后，从本包目录运行：

```sh
npm run typecheck
npm test
```

这些命令不替代真实宿主的交互检查。无须 build 本包。测试运行仍使用 strip-only，不能用 transform-types 掩盖源码无法加载的问题。

## 1. 问卷与结果

准备至少两题：一题带 preview 的单选，一题多选；填写具体 context、2–4 个带 description 的选项。

- 逐题选择、返回已答题、再次确认：不能把原答案意外改成第一项；多选应定位到 Next。
- 在自定义行输入两行和粘贴长文本，浏览选项、切题再返回；提交全文，不提交 paste 摘要。
- 同一多选勾选两项并输入自定义文本，分别用输入内确认和 Next 提交；`selected` 与 `answer` 都存在。
- 单选空自定义确认不推进。只回答部分题后提交，正文和 `details.unanswered` 明示未答题。
- 逐题 notes 不使题目变成已答；Submit tab global note 切题后仍在。只提交 global note 是正常提交，取消则正文仍为拒答。
- 校验空 context、重复题/label、保留 label 和嵌套 JSON 字符串；预处理只解码形状正确的部分。包含 CR 的文本在 UI、prompt 和结果一致。
- 在原生工具历史查看收起/展开回执，不能改变给模型的完整 envelope。

## 2. 控制请求与独立草稿

准备两道单选题，在第一题自定义行写两行但不提交。

- 选择 Chat 后立即返回讨论请求，不出现额外编辑器，不把未提交的自定义草稿当答案；此前已提交的答案仍保留。
- 在另一份问卷打开 Explain，输入独有标记，Esc 关闭再打开；它与自定义回答分别独立。
- 切到另一题重复操作，不能串草稿。编辑中页脚不能声称 Tab 一定切题。
- Explain 分别提交空文字与非空文字；Chat 直接提交讨论请求。两者都不是答案或取消，保留已有答案。Explain envelope 含 context、目标题和选项描述，要求立即解释；Chat 允许先讨论疑虑。

## 3. 滚动、布局与按键

在 regular/fullscreen 两种 TUI 检查：

- 单份问卷 inline，`PageUp`/`PageDown` 可滚动 transcript；mouse events 可用时滚轮也可用。无 mouse events 时按终端表现记录，不误报成问卷吞滚轮。
- 短终端、长 context/选项/preview/notes 下，70% 高度预算内 header、焦点和页脚可见；notes 和 Explain 编辑器跟随光标，不被滚动标记覆盖。
- 横向缩放跨过 100 列，preview 并排/下置切换，闭合边框与隐藏行提示可见。
- 第二份问卷或已有交互 overlay 时走 fallback；纯状态 overlay 不抢 inline。折叠/展开不丢答案，折叠时输入不能改动隐藏草稿，已有 overlay 上的问卷只缩成一行，不让下层关闭误删问卷。
- digits 单选确认、多选切换、自定义行仅进入编辑；编辑器里数字是文字，Next 不占数字。`notesKey` 为 digit 时保留 notes 优先级。
- 测 `notesKey: "т"`、`"ctrl+n"` 与 Kitty 编码；Space、裸 notes、modifier、repeat/release 不混淆。改 Pi submit/newLine 后确认与换行仍分别生效。

## 4. 取消与并发

分别在加载前/加载中、inline、overlay、折叠、notes/控制编辑器和 RPC 等待时触发执行取消。

- 调用能结束，不把未提交草稿或默认选项当答案；没有遗留 UI、raw listener 或阻断下一次提问的等待状态。
- 已进入 blocked 的调用最终有匹配 `toolCallId` 的 false；未进入等待的同步外部作答不凭空制造等待。
- Esc 在 notes/控制编辑器内只关编辑器，退出编辑器后再 Esc 才取消问卷。
- 外部答案与用户提交/取消竞速时，只有一个结果生效；后到的入口请求有拒绝 verdict；custom UI 返回 undefined 并切入 RPC fallback 时，也不能丢弃已收到成功 verdict 的外部答案。并行两份问卷不能互相清理或串答案。

这里检查可观察结果，不把某个宿主的关闭帧时序当公共合同。

## 5. RPC 与无 UI

用宿主原生 select/input fixture，不靠 TUI 按键模拟 RPC：

- context 和选项说明可见；custom follow-up 取消/空白返回选项，已有答案不丢。
- 选项行、纯编号和文本 `2 but change the title` 分别得到正确选项/自定义结果。
- 多选 `1,3; custom answer` 同时保留两部分；未知文本不截断。
- Chat/Explain 可选输入取消按空文字继续对应请求；题目对话框取消才取消问卷。原生 notes/global notes 缺失是明确降级。
- 外部 answer 返回 `unsupported_host`；无 dialogs 返回 `no_custom_ui`，模型不能把它解释成用户拒答。
- 无 UI 不向 provider 暴露工具；同一 SDK session 恢复 UI 后仍不自动加入 Ask，即使 active 列表未变也一样。Host/用户显式 `setActiveTools` 后才恢复可用；新 session 按初始 selection 初始化，兄弟工具保持不变。codemode only 仍能由模型直接调用，脚本不能调用。

## 6. 缺协作者、配置与 cold load

独立启用 Ask，不加载 perf、tmux bridge、样式插件或 i18n extension：

- 问卷、原生回执与结束等待都可用；没有事件消费者不影响流程。
- 无 i18n SDK 时英文可用；只装 SDK、未启用 i18n extension 时可读共享 locale；缺 key 回退英文。
- 隔离 XDG 和 legacy 文件，核对首选/缺失 fallback/错误不 fallback；无写入或 chmod。错误类型的 key、坏 JSON、不可读/非普通文件都降级。
- 文件版本不变时不重复读取解析或警告；更换文件/配置路径后重新读取；已打开问卷不被配置热改。
- idle 不加载渲染图，首个真实 TUI 调用才加载；并发 cold call 不拿到半初始化 class，失败后不留永久 in-flight promise。加载失败仍要求改用聊天并重启。
- 可信同进程 answer 消费者按 toolCallId 工作：同步代答、合法多选加文本、非法全有或全无、重复提交、取消和每次 verdict 都覆盖；不把此 fixture 当成远程认证能力。
