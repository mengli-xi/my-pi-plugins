# 配置

配置可选，缺省即可使用。本包只读配置，不创建目录、不写文件、不改权限；配置保留在官方 XDG/legacy 位置，不搬进 Pi 目录。

## 查找顺序

1. 用 `@juicesharp/rpiv-config` 的官方路径解析查找 `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`。`XDG_CONFIG_HOME` 必须非空且为绝对路径；开头的 `~` 先展开，相对值忽略。无有效覆盖时使用当前用户 home 下的 `.config`。
2. 只有首选文件不存在时，才检查 legacy `~/.config/rpiv-ask-user-question/config.json`。legacy 路径刻意不受 `XDG_CONFIG_HOME` 影响；不能硬编码某台机器的 home。
3. 两处都不存在，使用默认值。

首选文件存在但内容错误或不可读时，不再用 legacy 覆盖它。JSON 语法错误会警告并使用默认对象；合法 JSON 若不是对象（例如 `null`、数组或字符串），静默用默认对象。无法读取或不是普通文件时警告并降级，不让问卷被配置文件阻断。

读取器用路径和文件版本信号缓存结果；文件未变时不重复读取、解析或重复发同一内容的警告。切换路径或版本变化后重新读取。这个缓存不监听文件，也不让已经打开的问卷实时变更快捷键。这里只读普通文件，不把 FIFO/设备当配置流读取。

## 设置

```json
{
  "collapseKey": "alt+o",
  "notesKey": "ctrl+n",
  "guidance": {
    "promptSnippet": "Ask me before guessing on a meaningful decision",
    "promptGuidelines": [
      "Batch clarifying questions into one ask_user_question call.",
      "Ground context in the user's current task and a concrete example."
    ]
  }
}
```

| 设置 | 含义 | 默认 |
| --- | --- | --- |
| `collapseKey` | 折叠/展开问卷 | `"ctrl+]"` |
| `notesKey` | 打开逐题或全局 notes | `"n"` |
| `guidance.description` | 完整替换模型所见 tool description，不合并 | 内置 description |
| `guidance.promptSnippet` | system prompt 中的一行工具介绍 | 内置 snippet |
| `guidance.promptGuidelines` | 模型使用工具的规则列表，整体替换 | 内置 guidelines |

类型错误的字段不做字符串等隐式转换，分别回退默认；一个字段无效不影响其他有效字段。快捷键在新问卷创建时读取；guidance 在工具注册时读取，修改后重启 Pi。已打开问卷不受后续修改影响。

### `collapseKey`

先去首尾空白、转小写，再按 Pi key spec 校验：零个或多个不重复的 `ctrl`、`shift`、`alt`、`super`，以 `+` 连接，最后是基础键。

基础键接受 ASCII 单个字母、数字或常见可打印标点（不含 `+`），以及 `escape`/`esc`、`enter`/`return`、`tab`、`space`、`backspace`、`delete`、`insert`、`clear`、`home`、`end`、`pageup`、`pagedown`、`up`、`down`、`left`、`right`、`f1`–`f12`。

例如 `"ctrl+]"`、`"alt+o"`、`"ctrl+shift+h"`、`"f9"`、`"ctrl+}"`。`"off"` 不区分大小写，关闭快捷键且不注册 raw terminal listener；页脚、折叠行和通知都显示配置后的按键，off 时不再提示。

错误 modifier（例如 `"ctr+]"`）、重复 modifier、空片段等回退默认。不能把宽松 parser 误接受的值送进 raw listener，否则拼错修饰键可能捕获裸按键。

### `notesKey`

去掉首尾空白后，单个字符按实际输入匹配，保留大小写，支持非 Latin 字符，例如 `"т"`。更长字符串按上述 key spec 校验，例如 `"ctrl+n"`、`"alt+o"`。使用 Kitty keyboard protocol 时，带 modifier 的 spec 可以利用终端报告的 Latin 等价键。

问卷已经用来导航的裸键（Space、Enter/Return、Tab、Esc/Escape、箭头）不能用来抢占 notes；无效值回退 `"n"`。配置为 digit 时 notes 优先于行号选择。提示显示实际配置值；文本编辑器内仍正常输入字符，不触发 notes。

### `guidance.*`

`description` 和 `promptSnippet` 只接受非空字符串；`promptGuidelines` 只接受非空数组，且每项都是非空字符串。其他值回退对应内置文本。有效值整项替换，不做自动合并。

覆盖 description/guidelines 会替换本地关于 `context`、讨论和解释的提示。定制者必须自行保留这些要求；覆盖提示不会改变 schema 的必填字段、保留 label 或运行时校验。

## 环境与依赖

`XDG_CONFIG_HOME` 只影响上述配置查找。语言配置由 optional i18n SDK 管理，见 [localization.md](localization.md)，不要在此包新增另一份 locale 文件或 Pi 专用路径。

运行时使用共享库 `@juicesharp/rpiv-config` `^2.15.0` 的公开路径和 guidance 接口；本包保持只读并处理自己的缓存与字段校验。无需 API key，也不读取其他插件的私有配置。
