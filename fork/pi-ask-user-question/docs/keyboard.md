# 键盘与布局

本页定义终端问卷的操作；RPC 差异见 [hosts.md](hosts.md)，结果字段见 [tool-schema.md](tool-schema.md)。

## 默认按键

| 按键 | 行为 | 适用位置 |
| --- | --- | --- |
| `↑` / `↓` | 上下移动，选项列表两端循环；编辑时先在文本行间移动，到边界再返回行导航 | 选项、Submit picker、编辑器 |
| `Enter` | 确认选项、提交文本、关闭 notes 或执行 Submit 行 | 当前焦点 |
| `Shift+Enter` | 插入换行 | 文本编辑器 |
| `Esc` | 取消问卷；notes/控制编辑器打开时只关闭该编辑器 | 当前焦点 |
| `Tab` / `Shift+Tab`，`→` / `←` | 下一/上一 tab，循环 | 多题、且没有文本编辑器占用该键时 |
| `1`–`9` | 操作对应编号行：单选确认，多选切换，自定义行只进入编辑 | 选项列表 |
| `Space` | 切换当前多选选项；自定义输入中输入空格 | 多选题 |
| `n` | 打开逐题 notes；Submit tab 上打开 global note | 非文本输入状态；可用 `notesKey` 配置 |
| `Ctrl+G` | 用 Pi 配置的外部编辑器编辑当前自定义草稿 | `Type something.` |
| `Ctrl+U` | 清空当前自定义草稿，不取消问卷 | `Type something.` |
| `Ctrl+]` | 折叠/展开 | 可用 `collapseKey` 配置 |

实际确认/换行键遵循 Pi keybindings。确认同时接受 `tui.select.confirm` 和 `tui.input.submit`；`tui.input.newLine` 优先于确认。因此把 Enter 改成换行、把提交改成 `Ctrl+Enter` 后，问卷也应按该配置操作。

digits 只在行导航时选行；`Type something.`、notes 和控制编辑器中的数字是文本。绑定到 Pi 操作或 `notesKey` 的 digit 保留原意；`Next` 不分配 digit。Kitty keyboard protocol 的按键编码同样支持多选 Space 和 notes；修饰键不能被误当成裸 `n`。折叠只响应初次 press，忽略 repeat/release，避免一次按键折叠后立刻展开。

## 自动追加的行

| 行 | 何时出现 |
| --- | --- |
| `Type something.` | 每题 |
| `Chat about this` / `Explain More` | 单选题，在自定义行后，用分隔线与答案区区分 |
| `Next` | 多选题 |

这些 canonical label 保留给运行时，模型不能手写。自定义行和 Next 随 UI 本地化，两个本地控制 label 保持英文。

### 自定义回答与多选

`Type something.` 获得焦点后变成多行编辑器；有 preview 时扩展到 pane 全宽，不把输入挤进左栏。浏览其他选项后仍显示自己的草稿，按题隔离。粘贴多行保留完整文本，不把编辑器显示的 paste 摘要当答案。单选提交空白草稿不推进、不记录空答案；要跳过可切到别题后部分提交。

多选普通行的 Enter 与 Space 都是切换 checkbox，不是提交。焦点移到 `Next` 后 Enter 才提交；Space 不执行 Next。自定义行有文本时显示已选状态；输入内提交或用 Next，都返回勾选项加自定义文本，不能丢掉一半。回到已答题时，选项答案定位到原选项，多选定位到 Next，避免习惯性 Enter 覆盖答案；自定义答案返回时不自动进入编辑。

### 讨论与解释

单选中，确认 `Chat about this` 立即返回讨论请求，没有额外的 Chat 编辑器或草稿。第一次确认 `Explain More` 打开带标题/边框的可选编辑器；再次确认提交解释请求，空文本也合法。Esc 只关解释编辑器并保存草稿，重新打开可继续。解释草稿按题保存，不能出现在自定义回答行，不能覆盖自定义草稿；不同题之间也不能串。

控制请求的用途和模型应做什么见 [tool-schema.md](tool-schema.md)。进入文本编辑后，页脚只提示此时真正可用的操作，不在 Tab 被编辑器占用时声称可切题。

## Notes 与 Submit

`notesKey` 在任意题打开该题 notes；notes 独立于答案，写 note 不会消除「未答」提示。关闭后题面用 `Note for this answer: …` 显示首行，重新打开继续编辑。Enter 或 Esc 关闭 notes，换行/粘贴保留文本；编辑器内的 `n` 就是文本。

多题才有 Submit tab，用来复核答案、查看未答题并提交或取消。这里的 `notesKey` 打开覆盖整份问卷的 global note；它切题不丢，也不把任何题标成已答。note 对结果的影响见 [tool-schema.md](tool-schema.md)。

## Inline、滚动与 overlay fallback

默认问卷在 transcript 下方的 Pi editor 区域显示。高度预算为终端的 70%，最少 12 行；超出预算时问卷内部滚动，固定 header/问题和页脚，并让当前选项或 notes/Explain 编辑器的当前光标行保持可见。preview 按剩余空间缩小，保留边框与隐藏行提示；滚动标记不能覆盖焦点行。

inline 时 `PageUp`/`PageDown` 和鼠标滚轮留给 transcript。滚轮是否可用取决于终端是否发送 mouse events：有些终端把滚轮变成 ↑/↓，那只会移动选项；tmux 也受 mouse mode 影响。Mac 可用 `Fn+↑`/`Fn+↓`。不要求安装 tmux。

以下情况回退 overlay：

- 已有一份 inline 问卷占用 editor，第二份问卷打开。
- 已有会接收键盘焦点的 overlay，问卷必须叠在其上，保证看见的问卷就是收到输入的问卷。

只显示状态、不抢键盘的 overlay 不触发这种回退。overlay 模式下宿主会把 `PageUp`/`PageDown` 交给它，不能承诺 transcript 与 inline 一样滚动。

## 折叠

inline 折叠成一行，保留焦点与所有答案/草稿，同一按键展开。折叠时除取消和展开外忽略其他输入，避免修改看不见的答案。

作为第二份问卷打开的 overlay，只有宿主提供 raw terminal input、能够重新展开时才真正隐藏；否则只缩成可见的一行。真正隐藏后可读 transcript，同一快捷键通过 raw listener 重开。首次隐藏通知显示配置后的实际按键。

问卷若打开在已有交互 overlay 上方，折叠也只缩成一行并保留焦点；不能隐藏后让下方 overlay 的关闭误删它。另一个 overlay 占用焦点时，raw collapse listener 不抢它的按键。`collapseKey: "off"` 时不注册折叠快捷键，也不展示相关提示。

## 预览与小终端

单选选项带 `preview`，且终端和 pane 都至少 100 列时，左边选项、右边 Markdown preview。更窄时把 preview 放到下方；多选不渲染 preview pane。终端缩放时重新分配宽高。内容截断用 `↑`、`↓`、`↕` 表示方向；页脚太窄用 `…`，不能为了长提示挤掉核心操作。
