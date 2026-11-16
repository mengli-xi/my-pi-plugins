# 配置

[返回包入口](../README.md)。

## 来源与受管示例

配置来自实际 `getAgentDir()/pi-processes/config.json`；`getAgentDir()` 遵守 `PI_CODING_AGENT_DIR`，不猜测其他进程的 agent directory。

```json
{
  "schemaVersion": 1,
  "execution": {
    "helperRuntime": "<verified-runtime>/helpers/bun",
    "isolation": {
      "version": 1,
      "owner": "example-owner",
      "revision": 1,
      "removeEnv": ["EXAMPLE_BROKER_ID", "EXAMPLE_REPLY_FD"]
    }
  },
  "managed": {"requireTimeout":true,"maxTimeoutSeconds":7200,"terminalWake":"required"}
}
```

shell 接受绝对路径的 sh、dash、bash、zsh（Linux `/bin/sh` 可指向 dash），仍校验可执行性及 isolation authority。

这是受管配置示例，不是日常运行的必填设置。`managed` 和 `execution.isolation` 只允许出现在 agentDir 配置。可信 launcher 可在 Pi 启动前声明 `PI_PROCESSES_REQUIRED_ISOLATION`，Core 随后核实 owner/revision 与冻结配置；未声明的 launcher 不会被自动识别或剥离外部专用 env key。声明格式、removeEnv、authority 漂移、timeout 与清理规则见[执行合同](MANAGED_EXECUTION.md)。本包不写入或自动迁移日常配置。
