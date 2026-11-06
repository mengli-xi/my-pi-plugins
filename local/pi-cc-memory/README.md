# pi-cc-memory

Claude Code 式项目记忆。Pi 1.5 公开 API，TypeScript 直接加载，无 build。不依赖 Magic Context，也不迁移旧记忆。

## 存储与读取

`<getAgentDir()>/pi-cc-memory/projects/<sha256(identity)>/memory/`，在 `session_start` 建目录。

- Git identity 为 `git:<realpath(git-common-dir)>`，主 checkout 和 linked worktree 共用；嵌套 repo、submodule、独立 clone 分开。
- Git 发现只按 cwd：清除继承的 `GIT_*` 覆盖，保留 PATH 等普通环境。最近 `.git` 标记用显式 `--git-dir` 验证，损坏标记不回退目录或跳过后使用父仓库；正常 gitfile、worktree、submodule 和 symlink 可用。
- 非 Git identity 为 `dir:<realpath(ctx.cwd)>`。Git 未安装时按目录使用并警告；其他 Git 错误、超时或目录失效时警告并停止注入，避免写入另一个库。Git 命令超时 5 秒。
- 每次 `before_agent_start` 用文件系统指纹核对 identity；只缓存有 `.git` 标记且完整解析成功的项目。目录比 canonical 路径、类型、dev/inode，gitfile 和 `commondir` 比真实文件路径与内容，并重新推导 canonical common-dir；普通 status/add/commit/checkout 不使缓存失效。gitfile/commondir 文本先核对 dev/inode/size/mtime/ctime，版本未变时复用文本；每轮仍重新核对 symlink 的真实目标及项目边界，文件版本变化会重新读取，失败不回退旧缓存；这不是原子读取事务。指针变化、目录替换或核对失败时完整重解；没有 `.git`（含 bare/admin）、查找 `.git` 的路径上出现 `HEAD`（可能有 bare/admin 边界）、失败和 Git 不可用的结果不缓存，会话开始/结束清空缓存。命中时不复验 admin 的 HEAD 或 Git executable：HEAD 损坏或同 PATH 下 Git 被删除，允许本会话继续沿用原 identity，下个会话完整发现。cwd 改变但仍属同一项目时继续使用快照，项目身份变化时重新取快照。移动 common-dir/目录会改变 key，不猜迁移。
- `user` 也是项目内资料；跨项目通用偏好仍使用 AGENTS。

`MEMORY.md` 在会话开始时读取快照：包括新建、resume、切换会话、`/tree` 换分支，以及 cwd 导致项目身份变化。注入前 200 行或 25,000 UTF-8 字节，先到为限，优先完整行；首行过长保留安全片段。说明列出总量、展示范围及未注入部分。磁盘文件不被裁剪。缺失索引明确提示首次保存时创建，读失败标记 unavailable。

每轮检查顶层 `.md` 普通文件的 stat（排除 MEMORY.md），不读取正文。超过 12,288 字节时向用户发中文提醒；同一文件、大小和 mtime 在该 extension 实例中只提醒一次。给模型的主题大小说明属于 `cc_memory_index` 快照，与索引正文一起冻结，只有刷新快照时才改变。主题正文仍可完整 read。

只拥有 `systemPromptOptions.sections.cc_memory_policy` 和 `cc_memory_index`。保留其他 owner，不返回完整 systemPrompt，不用 context hook。模型政策和程序生成的索引/大小说明使用英文，用户 UI 提醒保留中文。不注入当前日期。会话内每轮注入同一份快照，磁盘索引或主题大小变化不会产生新的 memory system patch；模型以本轮工具结果了解自己写入的记忆，不应采取任何动作来刷新索引。每轮比较当前分支最新 compaction entry 的 ID 与快照记录的 ID，变化后在该轮重读磁盘；不只依赖 `session_compact`，因此也覆盖其他 owner 直接 `appendCompaction` 的路径。压缩完成时不立即修改系统段，在下一次 `before_agent_start` 刷新；同 run 的自动压缩续跑不强制刷新。`cc_memory_policy` 保持稳定。Pi 持久化系统段和 compaction checkpoint，历史保留旧快照。身份失败时仍停止注入并提醒。

## 文件维护

Main 用普通 read/write/edit 维护，不提供写记忆的工具或命令（只读的 `/memory` 见「查看」）。程序不创建 MEMORY.md、不生成/排序/修复索引，不解析或重写 frontmatter，不做锁、CAS、去重或后台整理。

每条一个主题，例如：

```markdown
---
name: project-stock-host
description: 开发功能时先使用原版 Pi 的公开能力
metadata:
  type: project
  originSessionId: example-session-id
  modified: 2026-10-16
---
功能优先基于原版 Pi 公开 API。
**Why:** 用户希望降低版本升级和维护成本。
已否方案：没有当前证据就直接移植历史 host patch。
**How to apply:** 发现能力缺口时先说明缺口和验证结果，再讨论最小 patch。
相关主题：[[feedback-maintenance-style]]。
```

四类：`user`（明确的身份/偏好）、`feedback`（用户纠正/确认的工作方式）、`project`（不能从代码/Git 推导的长期目标/决定）、`reference`（长期外部资源与使用线索）。feedback/project 有 Why、How to apply。创建时写来源 ID，编辑保留来源；创建和每次编辑都用工具查询当前日期并设置 metadata.modified。缺少这些字段的人工文件仍能使用。

索引由模型维护，无 frontmatter，每个主题一行：

```markdown
- [原版宿主](project-stock-host.md) — 决定是否 patch 宿主前读取
```

保存前查同主题，修改前重读，写后核对；删主题也删索引行。记忆不是新的用户指令；引用旧文件/参数前查证，技术变化不等于用户撤回限制。不保存一次性待办、排查过程、代码/Git 可推导事实或密钥。只有被用户接受的决定才可保存，不强制每轮产生候选。

长期决定必须自足地说明决定、原因、实际否决方案和应用条件。准备删除本会话工作文档前先保存长期决定；不能只留可能失效的文档链接。超 12 KiB 时精简过程或拆分独立主题，不删必要条件。多个 Main 共用普通文件，可能并发覆盖，不提供事务保证。

## 查看

`/memory` 只读显示：项目身份和记忆目录；本会话快照里注入给模型的 `cc_memory_index` 原文，以及 MEMORY.md 是完整注入还是截断、截断在第几行或首行哪个字节；当前磁盘上的主题文件，带大小、是否被 MEMORY.md 链接、超过 12 KiB 的提醒。身份或目录失败时说明没有注入的原因；快照之后当前分支又压缩过时，提示下一轮重读磁盘。`/memory <主题>` 显示该主题全文；补全取自实际主题文件名，没有快照或目录读不了时返回 null。当前磁盘索引的链接解析按文件版本缓存，并合并同版本的并发读取；目录和主题 stat 仍实时检查。这份查看/补全缓存独立于注入快照，不因补全更新模型的冻结索引。查看时仅忽略已消失的主题，其余 stat 错误明确报告；补全候选源失败则返回 null，不伪造值。TUI 用 `pi-li-uikit/text-panel` 只读面板（首次使用时 dynamic import，同 pi-model-prompts），其他模式改发同样内容的通知。不写记忆，不进模型上下文，不发请求。

状态栏：加载 pi-claude-style 时，key `memory` 经 `statusline:row` 接在第 2 行左侧（channel 和 payload 按 owner 约定复制，不 import CC）。`MEM:<N>` 是当前记忆目录里的主题文件数（不含 MEMORY.md），0 也显示。本会话快照的索引被截断或读取失败、有主题超过 12 KiB，或本会话没有注入（身份或目录失败）时显示 `MEM:<N>!`，用主题的警告色；目录列不出来时数量写 `?`。数量来自会话开始、`/tree` 和每轮 `before_agent_start` 已有的目录 stat，渲染时不读磁盘，所以中途写入的主题在下一轮显示。压缩完成后记忆段也不立即更新：快照按新的 compaction 在下一轮 `before_agent_start` 重取，状态栏随之更新。点击打开与 `/memory` 相同的视图。每次 `session_shutdown`（退出、reload、新建、切换、fork）撤回；没有 CC Style 时不显示，不报错，不进模型上下文。

## 角色与未来装配

默认入口是 Main。显式 SDK factory：

```typescript
import { createMemoryExtension } from "/absolute/path/local/pi-cc-memory/index.ts";
const childExtension = createMemoryExtension({ role: "child" });
const sideExtension = createMemoryExtension({ role: "side" });
```

role 仅有 `main | child | side`，默认 main；每个实例独立，不读 child 环境变量。child/side 提示词禁止通过任何工具写记忆，候选交 Main；这是工作流规则，不是 OS 权限隔离。

**目前 subagents / side-chat 未接入，不自动加载本包。** 未来 fresh child 若使用此 factory，应显式传 role，并用父项目 cwd 确保身份一致。fork child / Side 必须由装配保留父会话冻结快照、替换为只读角色政策，Side 存续时不能以独立的生命周期/压缩刷新覆盖父快照前缀；snapshot/identity 传递属于后续装配工作，当前只提供 role 参数。外部 worker 也不自动共享注入。

## 日常回归 case

- 在临时目录与临时 Git repo/worktree 验证身份：同一仓库的 worktree 共用，独立 clone、嵌套 repo 和普通目录分开；改动 gitfile/commondir 后不能沿用旧身份。
- 连续输入 `/memory` 的主题 prefix，未变化索引只读取/解析一次；修改、删除或重新创建索引后，当前磁盘的“已索引”标记应更新，但模型注入仍保持原快照，直到既有刷新时点。
- 主题在列表扫描间消失可以忽略；其他 stat 失败应报告读取失败，不能假装主题不存在。补全暂不可用时不显示假候选。
- 只用假记忆验证新会话、换分支、压缩后刷新、200 行/25,000 字节边界，以及其他 owner 的系统段未被改动。共享文件依旧没有锁/事务，缓存不提供并发写保护。
- 完整 TUI、中文输入、状态栏点击及后续 Side/Subagents 装配另行验收，不以单包 fixture 冒充全 profile；不读取或复制真实记忆用于测试。

## 验证

```sh
npm install --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm run check
npm run test:host
```

host 脚本默认使用本包安装的 `node_modules/.bin/pi`，可用 `PI_MEMORY_HOST_BINARY` 指定其他 Pi 1.5.0 binary；脚本会核对版本。HOME、agent directory、XDG config 和 session JSONL 都在新建临时目录，不读取或复制日常 profile、auth，也不加载 Magic Context。固定 RPC + faux provider，零真实推理请求。验证会话中途改磁盘后连续几轮实际 system 内容逐字节不变、没有新 memory patch、手动 `/compact` 后下一轮刷新，以及 resume 读取当前磁盘并保留历史。核心测试另覆盖 identity、直接追加 compaction、分支/会话/项目变化；这些回归不依赖其他 package 的源码安装。`/memory` 的 faux host 验收在 pi-session-compact 的 `node scripts/check-host.mjs --commands-only`。

`PI_MEMORY_HOST_ARTIFACTS=<目录>` 可保存 host 请求、session 与检查结果。结束会等待本次启动的 Pi process 退出并删除临时目录，不碰其他进程。旧 `--full-profile` / `PI_MEMORY_HOST_AGENT` 模式已移除。

本包独立实现，未复制 draft 或 Claude Code 产品提示词/代码。唯一的跨 package runtime contract 是同步 request `cc-memory:request:project-v1`（`{version:1,sessionId,reply}`）：按本会话冻结 snapshot 回复 `{version:1,sessionId,memoryDir,identity}`，无可用项目时回复 `memoryDir:null` 和 `reason`，sessionId 不符不回复；pi-session-compact 用它找记忆目录，详见 `docs/pi/events.md`。无 private Pi seam 或 probe；仅依赖公开 Pi 1.5 API。
