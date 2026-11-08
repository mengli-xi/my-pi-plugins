# pi-subagents · 信任与故障边界

## 1. 同进程信任

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0、唯一 SDK；managed native thread UI 另需 [UI_SPEC §5](./UI_SPEC.md#5-主题与终端释放) 的显式 host patch/UI capability，不构成 tools/model/provider 授权或 OS 隔离。Main、Side、Subagents 和 approved factory 同 JSprocess，共享 filesystem/network/credentials。frozen tool/model/role/ctx policy 减少误用但不构成 sandbox，任何 trustedextension 都能使用 process 权限。没有 socket/fd/nonce/env 构造的安全隔离、Agent process group 或 Supervisor hard kill；任意不响应 JS 工具只能 abort/fence，仍执行就 closing，不能声称已回收。

不自动 worktree/写锁，同 workspace 并发 read/edit/bash/Process 会 race；用户要协调文件所有权，package 不能隐式扩展外部 authority。Subagentprefix/taskpath 是领域身份，不是可执行路径。PI_SUBAGENTS_BACKEND 被彻底拒绝，不接受旧 marker 恢复权限。

## 2. 权限冻结与 caller

HostCaller 只由实际 Main/child/UI/recovery adapter 构造，模型 schema 不含 kind/generation/session 身份。Host 复核 binding/manager/runtime、Task ID、lifecycle/revision 与 Main owner；child 只操作直接 child 且 close/resume 仅 Main/可信用户。maxDepth 默认 1/max2，注册/active tools/profile/fingerprint/prompt/Host 全部执行 ceiling；不能通过手工 tool name 或伪 depth 越层。

创建冻结 role body/provenance/hash、model scope/model/effort/tier、cwd/trust/settings snapshot/delegation ceiling、tools/definition/approved factory hash；resume 不能读取变更 role 扩权、用 fallback model 执行或复制未知 Main plugin。public namespaces/factory module cache 不共享 runtime instance/options，provider auth 只在公开 ModelRuntime 解析，不持久 secret。closed history 仅 in-memory read view/空 tool，不自动 resume/模型请求。本轮 builtin consumer 仅 codemode/tool-search canonical factory，前端/后端一致且受 role/tools fences；`builtin_proof={version,pi_version}` 核对 canonical Pi.VERSION，不对 builtin 标识做物理文件 SHA 读取。其他 builtin 默认不启用，llama.cpp 非工具、不启服务；未知 owner 拒绝而非扫描 ambient paths。非 builtin Search/Processes 的 `execution_factory` proof 才直接读取实际物理 factory 文件做 SHA 校验，wrapper hash 不证明未校验文件可信；旧 profile 可读历史，缺 proof 不执行。

当前 MCP 来自 pi-mcp-adapter；child 继承需 adapter 自己明确能力声明/工厂及后续独立验收，现在不宣称支持。不以 stock MCP 替代，不解析其配置、冻结 raw 凭据或增加配置 pinning。共享 Runtime 通用显式 Builtin 接口仍默认全禁，保留的可选 MCP 支持不授权本 consumer。

## 3. 持久性与路径

agent-dir 走公开 Pi API/PI_CODING_AGENT_DIR。store-v2 只读自身 closed-layout、same UID、no-follow 目录/文件，directory0700/file0600，单 writer lock、canonical JSON/digest/CRC/journal 连续 revision 保护 metadata authority；symlink/malformed/identity 不明保 bytes 并 degraded/unavailable，不能猜损坏或覆盖。native JSONL 和 journal 独立提交域，ID/hash proof 对账才能认 append，不从 text 猜成功。

prepare token 仅 live 内存，磁盘 hash 不授 commit 或 lease authority；before commit frozen artifacts 和 owner lease 完整验证，uncertain commit 保留 prepare/lease 并 fence，不能静默 retry。log 只 bounded code/correlation/health，不记 prompt、正文、tool args/results、credential、token 或完整 private path。旧存储不读、不转换、不删除。历史报告随原仓归档，未迁入，不是生产 diagnostic ABI 或新验收证据。

## 4. 生命周期与取消

close 先持久 closing/取消 current/queue/input/barrier，再 leaf abort/public idle/control release/ACK/dispose，才 closed；JS 仍跑不释放 active/open。Task input/event 取消 terminalize 保 sequence/cursor，old generation callback 不能写下一 Task 或 resume 重放；late Process continuation 校验 owner token，确已失效/取消才 record-only；合法 active 位排队超过 30 秒不等于失效。watchdog/cancel 与同 Task/generation/lifecycle 收口，取消后不能由迟到 signal/grant 恢复工作。Main 所有 shutdown ending fence、撤销 append/view 权，再强关旧树；回旧 Main closed 不自动开工。

已完成 open 子树先 close/drain 再 delete；未 drain、投递债未退休或 revision 不符时拒绝，delete 不隐式 force 未完工作。forced queued Task 无 provider/usage0，已有 settled outcome 不可改；Completion/lease/Inbox/Outbox 需要继续收口，关闭不抹 unread 或 pending delivery。Main hard exit 后 cold recovery 以 host-lost 中断 unfinished/关闭 ownerless，不能 assistant tail 或 PID absence 推 success。

## 5. 投递与界面

Completion/body/XML/schema 均 bounded，unknown/malformed 消息降级 inert 文本，contradictory ID/hash 拒绝；tool call/result 未闭合不插普通 custom message。application 先 native/registry proof 再 journal persisted 再 ACK，transport 回调不当 proof；same ID 重放原 result，ACK 失败不再 release/Wake。Wake 每 epoch 唯一 owner 但特定 crash window 可 later 重复，逻辑幂等不宣传物理 exactly-once。

单前台 TerminalOwner/owner 引用 release，process listener 只删除 child public reference 差集，不动 Main；命名 theme 限制/return 恢复见 UI_SPEC。已读通过精确 Inbox receipt，onLoaded 自产活动标记与点击卡片是当前协调规则，不能以 render/scroll 或未挂载 CC panel 猜用户看到。

## 6. 非目标与验证

无恶意同 OS user/extension 隔离、OS 资源硬上限、hard kill JS 或跨 workspace 写事务。测试覆盖 caller 伪造/stale generation/depth/scope、artifact symlink/hash、prepared fault/lease 补偿、取消 input/recovery、foreground lease/listener 和 Wake proof；真实 provider/cache/IME/physical terminal、规模 heap/FD 自然释放独立验收，不用 faux 数据抵扣。
