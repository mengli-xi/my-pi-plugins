# 工具参数与结果

本页定义模型发送给 `ask_user_question` 的数据，以及模型和 Pi 得到的结果。宿主差异见 [hosts.md](hosts.md)，事件见 [events.md](events.md)。

## 参数

```ts
ask_user_question({
  context: string,
  questions: [
    {
      question: string,
      header: string,
      options: [
        { label: string, description: string, preview?: string },
        // 每题 2–4 个选项
      ],
      multiSelect?: boolean, // 默认 false
    },
    // 每次 1–4 题
  ],
})
```

`context` 是一个必填字符串，不再拆分字段。用 1–3 句简短的话，向没读过前文的用户说明：用户现在正在看什么或做什么、这个选择会改变什么，再给当前功能、数值或操作的具体例子。先讲用户能看到的影响，必要术语要解释成实际表现。不要写内部推理、复述题目/选项、未解释的名字/缩写/架构术语或文件路径。TUI 和原生 RPC 对话框将它放在 `Why this decision matters` 标题下。

`question` 写完整问题；`header` 是短标签。`label` 建议 1–5 个词；`description` 必须说明含义或取舍。推荐项放在最前，label 以 `(Recommended)` 结尾。`preview` 是用于比较的 Markdown（mockup、代码、图或配置），只给单选题。

| 字段 | 限制 |
| --- | --- |
| `context` | 不得为空或只有空白 |
| `questions` | 1–4 项 |
| `header` | 最多 16 个字符 |
| `options` | 2–4 项 |
| `label` | 最多 60 个字符；同题不能重复 |
| `question` | 同一问卷不能重复 |

长度和选项上限由参数 schema 检查；执行时的问卷校验不重复所有 schema 限制。解释措辞等要求属于模型 guidance，不是自然语言语义校验器。

### 参数预处理

Pi 的 `prepareArguments` 在 schema 校验前修复嵌套 JSON 字符串：`questions`/`options` 本应是数组，题目/选项本应是对象时，只在字符串能解析成对应形状时解码。普通参数保持原样，错误形状仍交给 schema 报错；这不是放宽必填字段。

入口统一规范化文本换行：`\r\n` 变成 `\n`，单独的 `\r` 删除，不变成空格或新行。校验、TUI、RPC、结果和 prompt 事件使用同一份规范化文本。

### 保留 label

模型不得写 `Other`、`Type something.`、`Chat about this`、`Explain More`、`Next`。界面自动补上适用行；比较始终使用 canonical English，不随 UI locale 改变。即使某题不显示该控制行，label 仍保留。命中返回 `reserved_label`，优先于重复 label 错误。

## 错误

问卷校验或运行环境拒绝时，结果包含 `cancelled: true`、空 `answers` 和 `error`。schema 先拒绝的错误由 Pi 处理，不保证进入工具执行。

| `error` | 含义 |
| --- | --- |
| `empty_context` | context 为空或只有空白 |
| `no_questions` / `too_many_questions` | 没有题目 / 超过 4 题 |
| `duplicate_question` | 题目文本重复 |
| `empty_options` | 少于 2 个选项 |
| `reserved_label` / `duplicate_option_label` | 使用保留 label / 同题 label 重复 |
| `no_ui` | `ctx.hasUI === false` |
| `no_custom_ui` | 没有可用 custom UI，也没有完整 `select`/`input` fallback |
| `session_load_failed` | 问卷模块 import 失败 |
| `stale_module_cache` | import 返回的 namespace 缺少预期 session class |

UI 不可用或加载失败表示用户没有看到问题，不是用户拒绝。模型应读错误正文并改用普通聊天提问；修复方式见 [hosts.md](hosts.md)。

## 结果

```ts
{
  content: [{ type: "text", text: string }],
  details: {
    answers: Array<{
      questionIndex: number,
      question: string,
      kind: "option" | "custom" | "multi",
      answer: string | null,
      selected?: string[],
      notes?: string,
      preview?: string,
    }>,
    cancelled: boolean,
    globalNote?: string,
    unanswered?: number[],
    chat?: { questionIndex: number, question: string, notes?: string },
    explain?: { questionIndex: number, question: string, notes?: string },
    error?: QuestionnaireError,
  },
}
```

- 单选选项为 `kind: "option"`，`answer` 为 label；有 preview 时原文回传。
- 自定义单选为 `kind: "custom"`，空白自定义输入不构成答案。
- 多选为 `kind: "multi"`，勾选 label 放在 `selected`，自定义文本放在 `answer`，没有文本时为 `null`。两者能同时存在，不能相互覆盖。
- 逐题 note 放在答案的 `notes`；note 本身不算回答了该题。Submit tab 的全局 note 放在 `globalNote`。
- 允许部分提交；`unanswered` 列出未答题目的 0-based index，全答完时省略。多选显式提交空选择与完全没回答不是同一状态。

### 给模型的 envelope

正常提交使用 `User has answered your questions:` 开头，并以 `You can now continue with the user's answers in mind.` 结束。每个答案为 `"<question>"="<answer>"`，选中的 preview 跟在 `selected preview:` 后，逐题 note 跟在 `user notes:` 后。部分提交增加 `unanswered:` 题目列表；全局 note 作为最后的 `global note:` 段。

只有全局 note、没有逐题答案，也算正常提交。没有答案也没有全局 note，或用户取消时，正文统一为 `User declined to answer questions`。取消的正文始终是拒答；已有全局 note 可以保留在 `details.globalNote`，不能据此把取消当成同意。

### 讨论与解释

选择 `Chat about this` 或 `Explain More` 后，当前调用以控制请求结束；`cancelled` 为 `false`，保留之前的答案，在 `chat` 或 `explain` 中记录目标题和可选文字。它们不伪造该题答案。

`chat` 用于质疑假设、指出选项遗漏或讨论别的方向，模型可以先问用户想讨论什么。`explain` 要求模型立即用普通语言说明用户所处场景、解释陌生术语、比较选项差别并给当前任务的例子，不得先问「你哪里不懂」。控制 envelope 带上用户可见 context、目标题和已有答案；解释请求还带上选项 label/description，供模型逐项说明。可选输入只进入对应控制请求的 `notes`。

输入和 Esc 的边界见 [keyboard.md](keyboard.md)；原生对话框的限制见 [hosts.md](hosts.md)。

## Pi 原生工具回执

历史中收起的 call 用 `Ask` 和题目 header 表示；result 显示答案摘要，多题按题排列，未答题标为 `not answered`，notes 用 `✎` 行。自定义答案带引号，展示 label 时去掉 `(Recommended)`。展开（`Ctrl+O`）可看题目全文和已选 preview；拒答显示 `✗ no answer`，错误显示首行。

这是展示层，不改变模型得到的 `content`/`details`，也不需要某个样式插件接管回执。消费方应读结构化字段，不解析显示文字。
