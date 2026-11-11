# 测试 fixture

`pure-old-store.ts.txt` 是 mailbox 之前的冻结 Scheduler store reader，SHA-256 为
`eb5cb0605d3b6f463b1c69f3252103c8b91cb9f737bb874c185aad5e9d992d17`。
回滚测试只重定向其 `task.ts` import 到本包 helper，不需要旧仓库 Git 历史，生产不加载它。

`fulfilled-final-ack-lost.ts` 是本包维护的公开 mailbox DTO stand-in：pending 已删除，
fulfilled terminal 仍欠最终 ACK，修复必须零请求且只生成一次 source 终态。

`daemon-lock.ts` 在测试重启 daemon 前等待内核锁真正释放，避免把旧进程退出当成锁助手已退出。
