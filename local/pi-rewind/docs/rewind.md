# pi-rewind

不修改 Pi host，对 Pi session 做线性、破坏性 rewind；会话重绑使用下述三个明确探测的写入接口。

只裁剪会话历史，不撤销 `write`、`edit` 或 `bash` 已经造成的工作区文件变化，不执行 Git 回退。

- 在空且 idle 的 editor 中连按两次 Escape，或运行 `/rewind`。
- `/rewind undo` 恢复最近一次成功 rewind 删除的完整 JSONL 和原 leaf。当前进程会保留一个快速恢复点；每次 rewind 还会把原 JSONL gzip 归档到 `getAgentDir()/rewind-trash/`，所以重启或 reload 后仍可恢复。两种路径都只在同一 session、当前 leaf 和 rewind 后的文件字节没变化时生效；任何新 entry 或 branch 移动都会拒绝自动覆盖后续工作。
- `/rewind history` 只列当前 session ID 与当前 session file 同时匹配的持久归档；其他会话不进入列表。表格使用固定短列展示时间、目标角色、丢弃对话数和压缩体积。Space 切换选择，`a` 全选，`d` 删除已选项（没有已选项时删除 focused row），Enter 恢复 focused 记录，`v` 查看 target/discarded 详情。批量删除会先确认，只删除 recovery archive，不改当前 session；选中记录恢复前仍会执行与 undo 相同的 leaf 和 byte digest 校验，当前会话已有后续变更时不会自动覆盖。
- 对刚提交的 user turn，只要模型还没吐出任何内容，按一次 Escape 就会 abort 并把 prompt 直接 rewind 回 editor。内容一旦开始出现，Escape 保持 Pi 原本的 cancel behavior。
- 提交后、用户消息前插入的 system、custom 或 model/thinking change 不妨碍连接中回退；两者之间出现其他 user/assistant 消息则拒绝匹配。回退保留用户消息的实际父节点，包括 Pi 的工具集 system 消息，供下次提交继续复用。
- 连接中回退会立即显示 `Rewinding…` 状态，完成或失败后清除。整个 `/rewind` 流程（包括选择器、等待空闲与存档）只允许一个调用执行，后到的调用直接忽略；进行中的 Escape 不传给原编辑器，也不会打开第二个选择器。选择器的旧目标若已离开当前分支，会给普通提示并结束。
- Pi 的 `navigateTree()` 返回前已经把 prompt 恢复到 editor；重绑后的显式恢复负责原始 source/image mapping，不是文本首次出现的时点。从开始导航到文件替换、重绑与恢复快照准备完成，实例公开 `onSubmit(text)` 出口暂存真正提交的 text，并立即放回可能已被原生清空的 editor；成功后文本未改才清空 editor、调用原本的 onSubmit 一次。期间改过文本，或回退取消/失败，都不自动发送，文本保留。临时提示说明 `Enter sends after rewind completes`；gzip 归档不阻塞后续正常提交。
- 保护不分类或重放按键：各种换行和重绑都由原 editor 立即处理，只有原生实际调用 onSubmit 的普通提交、备用提交或空闲 follow-up 会被暂存。onSubmit 的后续赋值、包装与编辑器间复制仍受保护；`/rewind` 自己的提交在未回退时照常转发。成功放行走原有 onSubmit 下游，保留 `/`、`!` 与附件的正常处理。
- 边界是答案的第一段真实内容：非空的 thinking 或 text，或者一个已经点名工具、已经在流参数的 toolCall。判定在 `answer-content.ts`，看的是 partial message 里的 block，不只看事件类型。
  - 发出去的请求不算。`before_provider_request` 在 `agent_start` 之后几毫秒就触发，按它算边界，一次 Escape 根本来不及。
  - provider 先开出来的空 block 也不算。`text_start` / `thinking_start` 在 block 还是空串时就发出来（pi-ai `api/openai-responses-shared.js:344-363`、`api/anthropic-messages.js:408-427`），`pi-agent-core/dist/agent-loop.js:209-226` 把它们逐个转成 `message_update`；见到 `message_update` 就关窗，等于这条路径永远走不到，用户只看到 Operation aborted。
  - 工具反过来：provider 开 toolCall block 时工具名已经在里面，这一步已经发出去了，不能当成什么都没发生地 rewind。
- Escape hook 会原地 decorate Pi 的真实 editor。它保留 editor identity 与 autocomplete field，因此 pinned-layout 能继续让 slash-command menu 浮在 input 上方。
- picker 只显示当前 active path 上可见的 user message（含图片）。AI、tool result、thinking 与 custom message 都不作为 rewind 目标。history 的已有归档、目标角色与丢弃对话统计照旧。
- 选择 user message 会删除该 prompt 及后续对话，并将其文本恢复到 editor。
- rewind 不重建 runtime。它先用 public `ctx.navigateTree()` 走 Pi 自己的 `/tree` 移动：leaf 改位置、agent context 与 transcript 重建、extension 拿到 `session_before_tree` 否决权和 `session_tree` 通知；随后才裁剪 JSONL。被裁掉的正是这次导航已经挪出 active path 的部分，所以任何 extension 看到的都不比一次普通 `/tree` 更少。旧实现用 `switchSession()` 替换 session，会重建 services、重新注册全部 extension、再跑一遍 session 启动流程——用户看到的「整个会话 reload」就是它。
- 动 session 之前必须先 close 并 resolve editor-slot panel。清掉 `ui.custom()` component 并不会 resolve 它的 promise，在 row callback 里改 session 会让旧 `/rewind` command 和 main input loop 一直挂着，transcript 也会在打开的面板底下重绘。
- 裁剪后会把 live `SessionManager` 重新绑定到裁剪后的文件，让内存和磁盘一致；否则后续 append 会挂在文件里已经不存在的 entry 上。这一步依赖 `SessionManager.setSessionFile`，由 `npm run check:internals` 盯着。
- 选中的 root-to-message path 会原子写回同一 JSONL file。session ID、file path 与 display name 保持稳定；被丢弃的 branch 不再占据 active transcript。
- 裁剪前会创建 sibling backup。普通裁剪在第一次异步 I/O 前记录文件 inode/size/mtime，提交前比较并在同一 event-loop turn 内替换；准备期间追加或替换文件会中止裁剪并保留新状态，不自动重试或导航回过期 leaf。这不是防住任意外部写入的跨进程文件锁。
- session 重新绑定成功后，读取稳定 backup inode，在内存中生成 gzip，再进入有界的跨进程归档发布临界区。普通准备失败会尝试导航回原 leaf；重绑失败后的文件恢复先检查预期字节，不覆盖后来追加的内容。回滚/导航恢复失败会同时保留原始错误和恢复错误，并报告恢复文件线索，不冒充已恢复成功。undo 也通过临时 sibling 恢复，导航被 `session_before_tree` 取消时会恢复 rewind 后的文件和 leaf，undo 点仍可重试。
- archive 每次按原文件 SHA-256 校验压缩输入，读取恢复前还会校验解压长度和 digest。目录与文件权限分别为 `0700`、`0600`。保留规则是 7 天、100 条、总存储 500 MiB，任一条件超限就从最旧记录开始删；总量同时计算 gzip payload 和 metadata。清理在 archive create/list 时执行，不启动常驻 timer。确认损坏的记录仍会清理；权限或临时 I/O 错误则保留记录并报错，不能当成损坏删除或假装列表为空。跨进程归档锁按持有者 PID 加 `ps -o lstart=` 的进程启动时间识别持有者，避免 PID 复用后认错人；身份读不到（单次 `ps` 给 5s，仍未成功则短暂等待后重试一次）时拒绝操作，不跳过校验，也不假定持有者还活着。
- race-safe 自动恢复要求 session 目录支持 hard link。文件系统不支持时，rewind 仍按 copy fallback 完成并保留 gzip history，但自动恢复会 fail closed。archive 写入失败时沿用 system Trash fallback；Trash 也拒绝时，sibling backup 留在原地并显示文件名。测试用 `piRewind(pi, { trashBackup, archive })` 注入确定性策略。
- picker 中的 user-message image 始终显示为不含路径的 `[Image]`。写回 editor 时，rewind 把原始 `pi-clipboard-*` source 交给 editor owner；CC Style 若确认临时文件仍存在，会重建带 path 映射、可原子编辑的 `[Image #n]`，因此可直接删改或重新提交。owner 缺失、版本不兼容、文件失效，或多图只有部分可恢复时，rewind 会整体回退为无映射的 `[Image]`，绝不把临时路径留在 editor。`/rewind undo`、history restore 和 rollback 保存 source text，并在每次写回时重新执行同一恢复规则。

`/tree` 仍是 Pi 完整、非破坏性的 branch navigator。

## 检查

```sh
npm run check
PI_BIN=/path/to/pi npm run check:host
```

支持 Pi 1.5，TypeScript 直接加载，无 build/dist。共享依赖统一由根 workspace 安装。验证使用独立 HOME、agent/config/cache 与 session directory，不读取或改动日常 profile，不迁移真实 session、归档或图片。

检查脚本只证明 `setSessionFile`、`branch`、`resetLeaf` 的形状；文件裁剪、事件链与恢复行为还须用临时会话验证。测试以假 Trash 替代系统 Trash，以 faux provider 替代真实模型；fixture 操作 UI 不等于人工 TUI 验收。

## 操作与回归边界

归档包含完整原会话和 editor source，可能有敏感内容与图片数据；gzip 不是加密，勿提交或上传这些运行数据。连接中 Escape 只取消本地运行并回退会话，不保证请求没发给远端，也不保证不计费。

日常回归只用专门的临时会话：

- 空且 idle 的 editor 双击 Escape 打开 picker；非空输入和已经开始回答时仍走 Pi 原生取消。没有真实内容的空 text/thinking block 不应提前关闭回退窗口，工具点名后则不再直接 rewind。
- 选择用户 prompt，检查 session ID/path/name 稳定、prompt 回到 editor、后续 append 正常；代码文件不变化。重复 picker/Escape 不并发执行破坏性动作。
- 裁剪准备期间追加 entry，应保留新内容并取消文件裁剪；文件系统无 hard link 时普通裁剪仍能完成，但自动恢复拒绝。不要据此推断能锁住任意外部写进程。
- undo/history 正常恢复；有后来写入、branch 改动或备份篡改时拒绝覆盖。归档 metadata 暂时不可读时保留数据、报错，恢复权限后仍可读取。
- 导航被否决、重绑/回滚失败时检查具体错误及恢复文件，不继续盲目提交。回退期间按 Enter 只在成功且文本未改时发送一次；失败、取消或编辑后均保留文本不自动发送。
- 启用 CC Style 后，人工检查图片 marker、Enter/Alt+Enter、换行与 IME；缺 owner 或图片失效时应退回无路径的 `[Image]` 并提示重贴。人工完整 TUI 尚需单独验收。

诊断日志开关见 [配置](configuration.md)。
