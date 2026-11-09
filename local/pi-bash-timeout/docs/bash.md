# pi-bash-timeout

独立的 source-only Pi 1.5.0 extension，用同名 `bash` 覆盖内置工具。`timeout` 必填、单位秒、必须为正数；没有默认值，也不拦截或改写 tool call。参数说明提醒模型给网络/流式命令明确上限，长任务或需查看进度的命令改用 `process`。

## 加载

在使用者实际 agent directory 的 `settings.json` 的 `packages` 中加入部署后的绝对路径：

```json
"/absolute/path/to/pi-packages/local/pi-bash-timeout"
```

TypeScript 直接加载，无 `dist/` 或 build。工具定义设 `defaultActive: false`，让 Pi 原有的 `defaultTools` / 显式 `tools` selection 决定是否启用 bash；不在启动后调用 `setActiveTools()` 补救。本包不提供配置、命令、timer 或持久化文件。

## 执行与显示

只改变参数 schema 和 description 最后一句（从 optional 改为 required）。`command`、prompt snippet/guidelines、output schema、结果/报错、流式更新、abort、截断均沿用公开 `createBashToolDefinition`。每次执行从公开 `pi.getSettings()` 取得本会话的有效 settings，经 `SettingsManager.inMemory()` 的公开 getters 读取 `commandPrefix` 和规范化的 `shellPath`，与 stock Pi 1.5.0 `AgentSession._buildRuntime` 传入的选项一致。不读 settings 文件、不读取 private field；没有内置自定义 spawn hook/operations 选项，所以不传，保留 Pi 默认 session environment 和本地 shell 行为。Pi 自己继续拒绝无效 shell path、过大的 timeout 等。Pi 1.5 用 `pi-schema` 校验替换后的 JSON Schema，保留 stock 参数 coercion（例如 `"1"` 转成 `1`）；缺失、零和负值仍拒绝。工具不继承内置 `prepareArguments`，不会在校验前补出 timeout。

本包不注册 `renderCall` / `renderResult`；Pi 沿用内置 bash renderer，CC Style 仍按工具名 `bash` 分组为 `Ran N shell commands`，不新增 UI ownership 或 presenter 耦合。

## 子会话能力

`pi-runtime-contracts/child-capabilities-v1` 是 registry owner；Main 绑定每个 session 的 `pi-bash-timeout` descriptor，声明 targets `pi-subagents` 和 `pi-side-chat`，两者共用同一个 child descriptor、activation `required-only`、tools `["bash"]`，没有 commands/providers/hooks/requires。每次 `session_shutdown` 都幂等 dispose 全部 binding 和 registration，包括 new/resume/fork/reload/quit；Pi replacement 创建新的 extension runtime，再注册并绑定 descriptor，旧 runtime 不保留候选。stale release 沿用 registry 的 fail-closed 规则。

`extensions/child.ts` 仅导出 `createBashTimeoutChildFactory`。它与 Main 共用 `extensions/tool.ts`，只注册相同工具，不注册 capability、不读取 ambient child identity。Subagents 和 Side 的审计 catalog 只接受 owner/package `pi-bash-timeout`、`extensions/child.ts`、匹配的 target hash 和该具名 export；未知身份或定义指纹不匹配会拒绝，不退回无 timeout 的内置 bash。Side 仅在 Main 的 active bash 确实归本包 main descriptor 所有时安装同一个 named factory，注册前核对 Main/Side 的工具定义指纹；Main 未启用 bash 时不安装。父会话不加载本包时，bash 仍归 `builtin`，子会话沿用原行为。

协作边界：`pi-runtime-contracts`（workspace 依赖 child-capabilities-v1；registry shape 变化须回归）、`pi-subagents`（optional audited child factory、closure 与定义指纹；修改本包定义后必须重建/验证 Subagents）、`pi-side-chat`（required-only target、精确 catalog、同定义指纹与 Side schema/本地执行隔离）。

## 验证

```sh
npm run check -w pi-bash-timeout # 仓库根
```

新增的 fresh SDK session 回归对照包开/关的 defaultTools 空值、排除/包含 bash 和显式 tools；真实 new/resume/fork/reload/quit factory-cycle 回归计数未释放的 registry handle，并验证包路径/target hash 变化不会和旧 runtime 冲突。

核心测试覆盖 required/positive schema、原样委托 timeout/settings/abort/spawn hook、短命令和 `sleep 5`/timeout 1 的内置报错，以及 faux + 真实 Pi loop 拒绝缺失 timeout 且不执行。Subagents contract 和 faux child E2E 覆盖 closure owner、父子指纹与包缺席的 builtin fallback；全部零真实模型请求。
