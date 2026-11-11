# 当前设计取舍

## 独立调度与单写者

调度不依附 extension timer，Pi 退出后仍需运行，所以 daemon 是独立 Node/Bun 进程，可由 launchd/systemd user service 维护。工具和人工命令只提交 socket 请求，由 daemon 统一写任务与记录，不以双写轮询协调。

每个 agentDir 有独立 socket、store 和带目录 hash 的服务标识。daemon 使用 kernel advisory lock，锁助手丢失立即停止服务，诊断 PID 文件不授 ownership。drain 等待 active 子进程提交记录后才释放锁，避免更新造成双执行者。

## 两类目标只冻结 prompt

独立 agent 固定 cwd/provider/model/thinking，每轮新建 session，避免周期运行意外积累上下文；需要历史的任务使用 session 目标。没有纯 shell 目标，不把输出捕获和另一套命令安全面加入模型任务调度。

会话目标冻结其公开 cwd 和 sessionDir；从其他 cwd resume 会触发 Pi 跨项目 fork 确认，非交互进程可能不追加却正常退出，因此创建/更新校验和 executor 都拒绝缺 cwd，不从 daemon 当前目录猜测。

live Pi 是会话唯一 writer，通过共享 mailbox 接管投递；daemon 不直接追加它的历史。多个 holder 或身份不匹配时保持占用并显示诊断。无人持有时才允许原离线路径；已经进入 mailbox 的 intent 不因超时或重启退回离线执行。完整事务见 [mailbox 合同](mailbox.md)。

## 安全与可见边界

任务 prompt 通过 argv 传给 `pi --print`，其进程命令行因此对本机其他可读进程表的用户可见。这是 Pi CLI 命令行接口的限制，不是本包的额外暴露；prompt 里不要放秘密，需要机密输入时由模型运行时从凭据存储读取。

## 时效、故障与可观测性

结构化 once/daily/weekly/interval 替代 cron 字符串，时区在创建时固定。休眠、服务停机和忙碌受同一 tolerance，间隔按计划时间推进而非完成时间，避免长任务导致节奏漂移。失败无自动重试，既避免重复外部副作用，也不影响后续周期。

任务执行前持久 inflight marker、推进 watermark；owner 进程死亡后补失败记录而不重跑。mailbox 的 unknown 则保留 intent，不把没有真实 run outcome 的 crash 伪造成业务失败。永久 source receipt 独立于运行历史 retention，避免 ACK 丢失后因人类记录被清理而二次执行。

默认并发 5，队列仍受 tolerance；未读失败不随普通 retention 丢弃。失败同时记账并尽力发系统通知，桌面不可用只降级通知，不阻塞执行。任务 prompt 的显示身份与 LLM role 分离，transcript 可显示 `task`，原生 custom message 入模仍为 user。
