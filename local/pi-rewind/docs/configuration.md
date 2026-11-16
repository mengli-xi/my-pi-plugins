# 配置

[返回包入口](../README.md)。

本包没有偏好配置文件。归档保留上限是固定策略，见 [裁剪与恢复合同](rewind.md)。

## 诊断环境变量

设置 `PI_REWIND_TRACE_LOG=<file>` 可以让一次 rewind 把分段耗时写成 JSONL（abort 等待、tree 导航、JSONL 裁剪、
SessionManager 重绑、Trash）。不设这个变量时不碰文件系统。
