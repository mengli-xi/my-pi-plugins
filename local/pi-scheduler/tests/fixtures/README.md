# 测试 fixture

`pure-old-store.ts.txt` 是 mailbox 之前的冻结 Scheduler store reader，SHA-256 为
`eb5cb0605d3b6f463b1c69f3252103c8b91cb9f737bb874c185aad5e9d992d17`。
回滚测试只重定向其 `task.ts` import 到本包 helper，不需要旧仓库 Git 历史，生产不加载它。

`fulfilled-final-ack-lost.ts` 是本包维护的公开 mailbox DTO stand-in：pending 已删除，
fulfilled terminal 仍欠最终 ACK，修复必须零请求且只生成一次 source 终态。

它和 `local/pi-session-inject/test/fixtures/fulfilled-final-ack-lost.ts` 是同一份
「source 已提交、最终 ACK 丢失」事实的两个独立副本。包内测试不能 import 别的包的测试代码，
所以只能各自维护；但两边必须保持同一 session/task/injection 身份、同一冻结 mail 和同一
terminal evidence。共享库改变该事实（例如新增 proof 字段、改变终态 shape 或 expected 计数）时，
要同步修改这里，否则本包会在真实 transport 上验证过期事实。

`daemon-lock.ts` 在测试重启 daemon 前等待内核锁真正释放，避免把旧进程退出当成锁助手已退出。
