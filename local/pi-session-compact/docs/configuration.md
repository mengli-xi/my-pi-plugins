# 配置

[返回包入口](../README.md)。

## 来源与行为

配置路径 `<agent-dir>/pi-session-compact/config.json`。默认 mode main，smallModel 无内置 provider/model；显式格式 `{provider:"your-provider",id:"your-model",effort:"off"}`，effort 默认 off。small/auto/shadow/Main fallback 需要 frozen-source 而未配置时用当前 model/effort，并记录/通知；显式模型不存在或 effort 不支持则报告，不静默换 provider/更快模型。坏配置诊断，不替换默认值。

summaryTokens 退役，读取给中文禁用说明，不控制接收/渲染/cut/窗口最小值。outputTokens 仍限制生成并参与准入/计时；旧 retry 配置读取兼容，但 custom 每请求只额外一次，网络/退避遵循配置/Pi。

冻结输入、operation/session fence、失败冷却、私有原子运行日志、恢复对账保持。shadow 默认不采用，不拖延/替换主结果、不恢复状态；session 边界、下次压缩或 abandoned operation 取消 shadow，resume 只标 interrupted、不重放。

默认 totalTimeoutMinutes=10 active 分钟，0 只关闭总时限；queuePauseCapMinutes=30。队列、单请求时钟与隔离见 [活动合同](provider-activity.md)。原生 fallback 不受已耗尽 custom 总预算限制。吞吐规划估值 2000 input/120 output token 每秒、安全因子 3，不是服务承诺；显式新鲜模型吞吐 profile 仍检查陈旧/并发，窗口、deadline、retry 和原生准入独立。
