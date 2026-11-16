# 配置

[返回包入口](../README.md)。

本包没有独立的偏好 JSON；持久任务定义和工具参数见 [README](../README.md#配置与命令)。

## 运行环境

| 变量 | 用途 |
| --- | --- |
| `PI_CODING_AGENT_DIR` | profile 根目录；extension 使用公开 `getAgentDir()`，独立 daemon 必填 |
| `PI_SCHEDULER_BINARY` | 任务执行用的 Pi 绝对路径；独立 daemon 必填 |
| `PI_SCHEDULER_CONCURRENCY` | daemon 并发上限，默认 5 |

extension 默认解析当前 Pi package 的公开 CLI bin；编译版保留实际 Pi executable。证据缺失时明确报错，可显式指定 `PI_SCHEDULER_BINARY`，不猜 PATH 上的日常 Pi。daemon 由真实 Node/Bun 运行，不由编译 Pi executable 充当 runtime。
