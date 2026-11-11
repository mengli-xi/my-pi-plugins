# 术语表

| 术语 | 标识符 | 含义 |
| --- | --- | --- |
| 任务 | Task | 触发规则、目标、prompt、时区与迟到容忍的持久定义 |
| 触发规则 | Schedule | once/daily/weekly 指定时刻，或 interval 固定间隔 |
| 独立目标 | Agent target | 每次新建 session，使用冻结配置 |
| 会话目标 | Session target | 向指定 session 提交 prompt，使用其历史 |
| 计划时间 | scheduledTime | 按规则应发生的时间，间隔据此推进 |
| 迟到容忍 | toleranceMs | 从计划时间起允许的最大延迟，包括停机与忙碌 |
| 合并补跑 | coalesced catch-up | 容忍内错过多次间隔只补一次 |
| 占用 | occupancy | extension 登记的 session/PID/token/generation，daemon 持久保存并核对 PID 存活 |
| 投递意图 | injection marker | source 的冻结 occurrence，不能从当前可变任务重建 |
| 接管 | accepted | mailbox 已持久接受，不等于 native 已追加 |
| 已记录 | recorded | 完整 native carrier proof 已被 source 持久接收，不等于已完成请求 |
| 已满足 | fulfilled | carrier 获得一次成功 assistant 请求机会，不保证业务成功 |
| 终态确认 | terminal ACK | source 已持久接收稳定 fulfilled/cancelled 证据，可幂等重放 |
| 运行记录 | RunRecord | 人类可读的成功/失败/跳过/投递结果，不代替永久协议 receipt |
