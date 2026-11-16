# 配置

[返回包入口](../README.md)。

## ultra 配置与提示覆盖

配置在 <agent-dir>/pi-effort.json：

```json
{ "ultra": { "subagentTool": "spawn_agent", "subagentPackage": "local/pi-subagents" } }
```

<agent-dir>/ultra-prompt.md 覆盖文字；缺失/空文件用随包默认。每次按 inode/size/mtime/ctime 缓存正文、解析及失败，编辑/替换/删除下次使用可见。缺配置用默认；坏配置或不可读文件禁用贡献并按失败版本诊断一次，只含路径/原因不含正文，真实档位保持。模式开关由片段贡献，委派规则留在 subagents 技能；自定义覆盖仍须遵守权限。
