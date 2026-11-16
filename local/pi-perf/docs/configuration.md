# 配置

[返回包入口](../README.md)。

## 文件、环境变量与生效

配置在 `<agentDir>/extensions/pi-perf/config.json`，使用 `schemaVersion: 1`、`revision`、`overrides.enabled`，完整文档原子替换；损坏文件保留且只读、关闭采样。写入时发现外部修改拒绝覆盖，需重启后重试；不承诺配置的跨进程事务锁。未知字段保留但不生效。重启后细粒度探针始终关闭，低频采样遵守保存的 enabled。

`PI_PERF_ENABLED=0|false|off` 可在本次启动关闭；显式 `/perf on` 可恢复。`PI_PERF_MEMORY_SAMPLE_MS` 仅控制显式 on 后的细粒度内存采样（默认 10000）；合法的 Node timer 值保持不变，空值、非数、负数、低于 1 或超过 2147483647 回退默认。阈值类参数单独校验，允许 0（全部记录/每次触发）和正小数；非法或溢出回退默认，不套用 timer 的最小 1ms 规则。慢日志默认 50ms（`PI_PERF_LOG_MS`）、细粒度内存日志默认 60000ms（`PI_PERF_MEMORY_LOG_MS`）、loop stall 默认 50ms（`PI_PERF_LOOP_STALL_MS`）。
