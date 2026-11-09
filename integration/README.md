# 跨插件联测

全部使用 Pi 1.5 faux provider、临时 HOME/profile/session，零真实 provider 请求。
包内只保留本包单元/合同测试及不加载协作插件的 e2e。

## 降级门禁

仓库根运行 `npm run test:integration`：

- Compact 不加载 pi-cc-memory / pi-todo，真实阈值压缩后仍继续并完成请求；复用包内流式 fixture，不重复实现压缩算法。
- Subagents 与 pi-bash-timeout 的仓库内 child 联测也随默认入口运行。
- Effort 不加载 pi-model-prompts，真实 SDK 中 `/effort high`、`ultra`、`low` 改档，不隐式发请求；随后本地 faux 请求正常完成。
- [Skills + Compact](skills-compact.test.ts) 直接加载两个生产 entry point，检查 Skills 材料进入 faux transport 收到的真实压缩请求、规则只嵌入 checkpoint 一次、连续两次压缩与 legacy binding 恢复，以及外部 owner 引用不被 Skills 冒领。旧 restore-request 入口还会在真实 provider 请求前持久化独立恢复消息，重复请求不重复追加。分别缺 Skills、缺 Compact 时，普通请求继续；request-only 注入不进入持久 LLM message，resume 只恢复原 sidecar 版本，不重复追加。
- [Skills + CC](skills-presentation.test.ts) 在两种加载顺序中加载真实 Skills 和构建后的 CC；另用生产 presentation factory 与真实 Skills SDK row 组合，检查晚加载、owner 替换、旧 owner 退出和缺 CC fallback，不覆写 row 的 `render`。click 只交给测试侧 opener，不操作终端或剪贴板。

`npm run test:integration` 会先用 Bun 构建 CC，再运行联测；单独运行 Skills/CC 测试文件时须先执行 `npm run build -w pi-claude-style`，不以源码 mock 代替 `dist/index.ts`。这些用例使用根依赖中的 stock Pi 1.5.0 公共 SDK，不加载 patched SDK 或真实 provider。

无 pi-claude-style 的 Subagents child 视图可在 `npm ci` 安装的原版 Pi 1.5.0 上验证：

```sh
npm run test:integration:stock-host
```

使用临时命名主题、原版 SDK/CLI 和 faux provider，连续打开/返回两次，核对一次降级提示、
每次初始化与返回小于 2000ms、无 deadline fallback、配色及 Main editor identity 保留、零额外请求。
不加载 CC presentation，不发真实 provider 请求。主题文件热更新不在原版保证范围。

同一用例保留显式补丁宿主入口：

```sh
PI_PATCHED_SDK=/path/to/build/source/packages/coding-agent \
PI_PATCHED_CLI=/path/to/build/source/packages/coding-agent/dist/bundle/cli.js \
npm run test:integration:patched-host
```

需要同次构建的完整 SDK peer graph 和真正 patched CLI，构建见
[host patch](../host-patches/pi/v1.5.0/README.md)。没有路径就明确失败，不 skip、
不伪造 capability。测试 loader 仅在测试进程重定向整个 Pi peer graph，不改变外部 link。
该入口 build Subagents，再用 Bun PTY 打开原生 child 历史并返回 Main，核对 editor identity、
任务数及 presentation registry 缺席；只加载 Subagents 和测试侧 faux provider。

## 完整协作矩阵

`npm run test:integration:subagents` 运行 `integration/subagents/real` 下的 Node 联测。
包括直接加载其他插件的文件，以及通过 `fresh-host` 默认加载 Processes 的文件。
设置 `PI_REAL_BINARY`，先显式安装/构建这些测试原先依赖的 pi-processes、Goal、native-search 等协作方；
仓库不提供这些插件的仿制实现。缺协作方或宿主时应失败，不能把默认降级门禁通过当成完整协作矩阵通过。
原有全 profile 环境变量仍只用于显式矩阵；日常默认门禁不发现用户 profile。

Subagents 的三套 Bun PTY runner 在 `subagents/real/sdk-{child-view,statusline,initialization}.mjs`，
从仓库根 `bun <runner> <patched-cli>` 运行；须同时配置匹配的 patched SDK。
CC 的 child/provider renderer 联测与 Compact/statusline 联测在 `claude-style/`，
入口为 `bun integration/claude-style/child-ui.mjs <pi>`、
`bun integration/claude-style/context-compact.mjs <pi>`。这些矩阵保留原有断言及额外依赖，
不属于 stock 降级门禁。原 statusline 文档中的旧命令位置以本页为准。
