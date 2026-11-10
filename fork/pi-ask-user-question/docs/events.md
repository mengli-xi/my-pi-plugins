# 事件协议

本包通过 Pi 的 session event bus 提供问卷通知和作答入口。它不依赖监听者存在，也不自行联网。工具参数和结果见 [tool-schema.md](tool-schema.md)。

## 信任与兼容边界

以下无版本后缀的 `rpiv:ask-user:*` 名称是上游已有的 **legacy 兼容频道**，保留原名，不因 Fork 或目录迁移擅自改名。新协议应采用带版本号的频道；这些旧频道仍遵守原有规则：名称不变、字段只可追加且必须 optional、监听者容忍未知字段、payload 保持 JSON-safe。破坏性变化必须另开版本频道，不能给旧 payload 加一个 `version` 后改变旧含义。

总线只面向**可信同进程参与方**，不是认证或权限隔离机制。知道 `toolCallId` 的监听者可以代答，不能把未经认证的远程输入直接转发进来。若消费者自己搭建 phone/web/pane bridge，由消费者负责身份校验、授权和跨进程路由；本包不建立连接、不发现远程端点、不读取消费者私有存储。

`pi-perf`、tmux supervisor 等可以按需监听，但都不是提供本工具的前提，也不建立 runtime import 或 package 硬依赖。没有协作者时，原有本地 UI、作答与等待清理照常工作。

## 导出

从 `@juicesharp/rpiv-ask-user-question/events` 导入常量和 payload 类型，不复制字符串到各处：

| 常量 | 频道 | 方向 |
| --- | --- | --- |
| `ASK_USER_PROMPT_EVENT` | `rpiv:ask-user:prompt` | 本包发出 |
| `ASK_USER_BLOCKED_EVENT` | `rpiv:ask-user:blocked` | 本包发出 |
| `ASK_USER_ANSWER_EVENT` | `rpiv:ask-user:answer` | 本包接收 |
| `ASK_USER_ANSWER_RESULT_EVENT` | `rpiv:ask-user:answer-result` | 本包发出 |

## prompt 与 blocked

验证成功、显示问卷之前发出 prompt：

```ts
{
  toolCallId?: string,
  context?: string,
  questions: Array<{
    question: string,
    header: string,
    multiSelect: boolean,
    options: Array<{ label: string, description: string, hasPreview: boolean }>,
  }>,
}
```

本实现为 prompt/blocked 提供 `toolCallId`，类型仍为 optional 以兼容旧监听者。`context` 是去掉首尾空白的用户可见理由；旧发送方可能不带。只携带 `hasPreview`，不携带 preview 正文。文本使用工具入口的换行规范化结果。

等待用户输入时发出 `{ active: true, toolCallId }`；退出等待在 `finally` 发出 `{ active: false, toolCallId }`，覆盖答案、取消和错误。并行问卷各自关联，不能用单个 boolean 推断所有问卷已结束：消费者应按 `toolCallId` 维护等待集合。prompt 本身不等于已经进入等待，例如同步代答可以让 UI 根本不挂载。

## 外部作答

```ts
import {
  ASK_USER_ANSWER_EVENT,
  ASK_USER_ANSWER_RESULT_EVENT,
  ASK_USER_PROMPT_EVENT,
  type AskUserPromptEventPayload,
  type AskUserAnswerResultEventPayload,
} from "@juicesharp/rpiv-ask-user-question/events";

pi.events.on(ASK_USER_PROMPT_EVENT, (prompt: AskUserPromptEventPayload) => {
  // 示例仅处理一题；真实消费者必须按 prompt 的题目形状生成完整答案。
  if (!prompt.toolCallId || prompt.questions.length !== 1) return;
  pi.events.emit(ASK_USER_ANSWER_EVENT, {
    toolCallId: prompt.toolCallId,
    requestId: "request-1",
    answers: [{ questionIndex: 0, optionIndexes: [0] }],
  });
});

pi.events.on(ASK_USER_ANSWER_RESULT_EVENT, (verdict: AskUserAnswerResultEventPayload) => {
  // 用 requestId/toolCallId 关联；判断 ok/code，不解析 reason。
});
```

入口 payload：

```ts
{
  toolCallId: string,
  requestId?: string,
  answers?: Array<{
    questionIndex: number,
    optionIndexes?: number[],
    text?: string,
    notes?: string,
  }>,
  globalNote?: string,
  cancel?: boolean,
}
```

`questionIndex` 和 `optionIndexes` 都是 0-based，后者只索引模型给出的选项，不索引自定义或控制行。单选只能选一个选项，或给非空白 `text`，不能同时给两者；多选可同时给选项和文本。notes 去掉首尾空白，空 note 丢弃。取消使用 `{ toolCallId, cancel: true }`，不需要 answers。

- 从 prompt 发出的时刻就可作答，包括在 prompt listener 中同步发出答案；直到该问卷结束。
- **先完成者生效**，终端输入与事件共用同一道结算门。后到的请求不能覆盖结果。
- **严格、全有或全无**：外部作答必须每题恰好一次，索引合法且不重复，文本非空白。不合法时不应用任何部分，问卷继续等待。不要把 UI 的部分提交能力误当成此入口的能力。
- 未知字段忽略。此入口不提供 `chat`/`explain` 请求。
- RPC/ACP 的宿主原生对话框不能由此入口代答或取消。

## answer-result

每次入口尝试都有一次 verdict：

```ts
{
  ok: boolean,
  code?: "not_found" | "invalid_payload" | "invalid_answer" | "unsupported_host",
  reason?: string,
  requestId?: string,
  toolCallId?: string,
}
```

请求中的字符串 `requestId`/`toolCallId` 会原样回传。成功看 `ok`，失败按 `code` 分支；`reason` 只供人读，措辞不稳定。

| `code` | 含义 |
| --- | --- |
| `not_found` | 对应问卷未打开、已结束或已经作答 |
| `invalid_payload` | 缺字段或字段类型错误 |
| `invalid_answer` | 形状合法，但有漏题、重复题/索引、越界、空文本，或违反单选约束 |
| `unsupported_host` | 问卷在 RPC/ACP 原生对话框中运行 |

bus 以 session 为边界。child session 的 prompt 不会自动出现在父 session 的 bus 上；消费者必须明确连接正确 bus，不能用父 session 的事件假装回答 child session。
