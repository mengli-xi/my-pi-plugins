# 跨插件联测

全部使用 Pi 1.5 faux provider、临时 HOME/profile/session，零真实 provider 请求。
包内只保留本包单元/合同测试及不加载协作插件的 e2e。

## 降级门禁

仓库根运行 `npm run test:integration`：

- Compact 不加载 pi-cc-memory / pi-todo，真实阈值压缩后仍继续并完成请求；复用包内流式 fixture，不重复实现压缩算法。
- Subagents 与 pi-bash-timeout 的仓库内 child 联测也随默认入口运行。该用例分阶段记录 spawn、Task RPC、修正调用完成和 Pi 退出；RPC、completion 和退出分别最多等 60、45、60 秒，总预算 180 秒。spawn 失败立即报告，并等待同样会在启动失败时触发的 `close` 完成清理，不等待缺席的 `exit`；缺失 CLI 的子 runner 回归验证不会挂住。
- [Processes + Subagents](processes-subagents.test.ts) 使用真实 SDK child、Process 通知与 Task 记录，核对等待不延长 Task deadline、生产 admission factory 重验 cached grant、真实 60 秒期限，以及排队后取消/reopen 不恢复执行权限。测试不缩短生产 Task 的最小期限，不使用 legacy global bridge 冒充 SDK bridge。
- [Processes + Compact](processes-compact.test.ts) 在 Main/Side 连续压缩两次，核对真实 faux 压缩请求、checkpoint 内嵌状态和恢复去重；没有 Compact 时走原生压缩，且不隐式创建 Subagent Task bridge。
- [Search + child](search.test.ts) 校验声明的 factory 与实际执行文件 SHA、真实 Subagents 搜索-only 工具投影、父 backend bus 隔离；Main 与 CC 双顺序不改变工具执行 ownership。
- [Side Chat + Bash Timeout](side-chat-bash-timeout.test.ts) 校验独立 Side target、Main/Side 定义指纹、必填 timeout schema 和真实工具执行，不允许退回宽松 builtin。
- [Side Chat + Processes](side-chat-processes.test.ts) 使用真实 Side runtime，检查一次 watch wake，以及万条历史下真实 mailbox 写权限失败时保留目录/ownership、修复后 durable cancel 再销毁；另用非法 regex 确定性触发真实 matcher-error，核对一次错误 wake 后可销毁，并对真实 Supervisor SIGKILL 验证 containment 后仍能销毁 Side。
- Effort 不加载 pi-model-prompts，真实 SDK 中 `/effort high`、`ultra`、`low` 改档，不隐式发请求；随后本地 faux 请求正常完成。
- [Skills + Compact](skills-compact.test.ts) 直接加载两个生产 entry point，检查 Skills 材料进入 faux transport 收到的真实压缩请求、规则只嵌入 checkpoint 一次、连续两次压缩与 legacy binding 恢复，以及外部 owner 引用不被 Skills 冒领。旧 restore-request 入口还会在真实 provider 请求前持久化独立恢复消息，重复请求不重复追加。分别缺 Skills、缺 Compact 时，普通请求继续；request-only 注入不进入持久 LLM message，resume 只恢复原 sidecar 版本，不重复追加。
- [Fast + child factories](fast-child-factories.test.ts) 用 Subagents 的真实 Task 与 Side runtime 验证 priority body、override 优先/全局默认/缺 Fast 降级、未知第三方 factory、创建时冻结、父 child resume 后的嵌套继承和两种加载顺序；全部经 faux transport。
- [Fast + CC](fast-statusline.test.ts) 用真实 SDK 和构建后的 CC 验证两种加载顺序、即时 slot 更新和 priority 请求注入；缺 Fast 时 CC 与普通请求照常工作。包内 SDK 回归另验证原生 compaction 与直接 registry stream 不受 Fast 影响，不发真实 provider 请求。
- [Skills + CC](skills-presentation.test.ts) 在两种加载顺序中加载真实 Skills 和构建后的 CC；另用生产 presentation factory 与真实 Skills SDK row 组合，检查晚加载、owner 替换、旧 owner 退出和缺 CC fallback，不覆写 row 的 `render`。click 只交给测试侧 opener，不操作终端或剪贴板。

根脚本 `test:integration`、`test:integration:mcp`、`test:integration:search`、`test:integration:ask`，以及 `test:integration:subagents` 的 Node runner 使用 `--test-timeout=300000`（5 分钟），作为缺省用例上限；用例自身显式 timeout 仍优先。根 `test` 的 `scripts/*.test.mjs` 阶段也设置该上限，但不传递到后续 workspace 测试、非 test-runner 命令、Bun/PTY 或独立宿主脚本；这些入口使用自己的期限。真实 Task deadline 用例至少等待生产的 60 秒，5 分钟为慢启动、正常期限和清理留出余量，不用无限超时掩盖失败后泄漏。Subagents RPC fixture（fresh-host 与独立 spawn）的正常退出预算统一为 60 秒，覆盖 Processes 的 33 秒 cleanup watchdog 和 Host 的 35 秒 cleanup 请求；已经发送 EOF 但未退出也必须 force-kill/reap，退出后才删私有目录。fresh-host 首次 `get_state` 也允许 60 秒冷启动，后续 RPC 保持 25 秒；相关 parked/compaction 用例预算为 120 秒，覆盖冷启动、操作与退出，而不改 Task/process deadline。退出计时由 test diagnostic 输出，超时不是退出成功。

`npm run test:integration` 会先用 Bun 构建 CC、Subagents 和 Processes，再运行联测；单独运行依赖 CC `dist` 的联测（Skills/CC、Fast/CC）前，要先执行 `npm run build -w pi-claude-style`，不以源码 mock 代替 `dist/index.ts`。这些用例使用根依赖中的 stock Pi 1.5.0 公共 SDK，不加载 patched SDK 或真实 provider。

无 pi-claude-style 的 Subagents child 视图可在按[根安装说明](../README.md#安装与加载)安装的原版 Pi 1.5.0 上验证：

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

## Side Chat 视图

```sh
PI_BIN=/path/to/pi npm run test:integration:side-chat
```

先构建 CC，再在真实 Main PTY 中分别验证 CC presentation 与没有 CC 的原生 Side，核对独立草稿/模型/effort、十次返回、同 PID、原 editor 和 terminal 恢复。CC 矩阵保留 compaction、外部 editor、销毁及 BTW/Main 共存断言。只有测试 Main 使用 PTY，不能据此把 Side 称为进程后端。

`integration/side-chat/sdk-view-e2e.mjs` 还保留显式 `PI_S2_BASH_TIMEOUT=1`、probe drift 和 shutdown/input 矩阵。它们不默认发现日常 profile；测试 provider/grant fixture 在同目录 `fixtures/`，没有真实认证或 provider 请求。单包的两个 BTW PTY 用例留在 `local/pi-side-chat/test/`，因为不加载其他插件。

## Goal 协作矩阵

[Goal](../fork/pi-goal/README.md) 已纳入根 workspace。包内只保留本包 domain/合同测试和独立 faux e2e；真实 Goal + Processes/Subagents 的 mailbox 矩阵在 [integration/goal](goal/mailbox-a1-matrix.mjs)，不借默认降级门禁声称完整矩阵通过。

先在仓库根显式构建三个生产入口，再指定 stock Pi 1.5.0 binary 和仓库外的证据目录：

```sh
npm run build -w @narumitw/pi-goal
npm run build -w pi-processes
npm run build -w pi-subagents
PI_GOAL_TEST_BINARY=/absolute/path/to/stock-pi-1.5.0 \
node integration/goal/mailbox-a1-matrix.mjs /absolute/path/to/evidence
# 同一矩阵反向加载顺序；用另一个证据目录
GOAL_JOINT_REVERSE=1 PI_GOAL_TEST_BINARY=/absolute/path/to/stock-pi-1.5.0 \
node integration/goal/mailbox-a1-matrix.mjs /absolute/path/to/reverse-evidence
```

矩阵可在证据目录后指定 case：`joint-b`、`joint-bd`、`joint-grant`、`joint-paused`、`joint-paused-split`。使用真实 mailbox engine/store 和生产编译入口，测试侧只控制公开 receive/release gate，不换 transport；断言 exact Main/child/request/carrier 数量、sealed member set、独立 cutoff 与 final pending 清空。暂停结果路径允许记录结果，不恢复 Goal、不调用 terminal tools。process 和 Task deadline 各自独立，Goal pause 不取消后台任务，巡检也不延长期限。fixture 使用临时 profile/session 与 faux provider；没有运行就不报告通过。

Processes 自己保留更广的显式 Goal 矩阵，不随默认门禁运行：

```sh
PI_PROCESSES_TEST_GOAL_ENTRY="$PWD/fork/pi-goal/dist/index.js" \
PI_PROCESSES_TEST_PI=/absolute/path/to/stock-pi-1.5.0 \
node integration/processes/goal-process.mjs
```

入口拒绝缺失的显式路径；先完成所需构建，不自动发现日常 profile。Goal 本包 stock runtime/mailbox smoke 与这里的联合矩阵分别验收，边界见 [Goal 维护说明](../fork/pi-goal/docs/maintenance.md)。

Goal 与真实 CC 的 TUI 协作使用独立入口，显式提供两个实际产物：

```sh
PI_GOAL_TEST_BINARY=/absolute/path/to/stock-pi-1.5.0 \
PI_GOAL_TEST_CC_ENTRY="$PWD/local/pi-claude-style/dist/index.ts" \
npm run test:integration:goal-ui
```

此入口共用原生 Goal 的真实 PTY 场景，并额外检查 CC 画面的 Goal 行和暂停后的时钟冻结；包内 `test:ui` 不加载 CC。虚拟 PTY 不是人工 IME/物理终端验收。

## 完整协作矩阵

`npm run test:integration:subagents` 运行 `integration/subagents/real` 下的 Node 联测。
包括直接加载其他插件的文件，以及通过 `fresh-host` 默认加载 Processes 的文件。
设置 `PI_BIN`（相对路径以仓库根解析，不随测试 cwd 改变），先显式构建本仓的 Processes、Goal 及这些测试所需的其他协作方；native-search 等外部插件仍须提供。
仓库不提供外部插件的仿制实现。缺协作方或宿主时应失败，不能把默认降级门禁通过当成完整协作矩阵通过。
原有全 profile 环境变量仍只用于显式矩阵；日常默认门禁不发现用户 profile。

Subagents 的三套 Bun PTY runner 在 `subagents/real/sdk-{child-view,statusline,initialization}.mjs`，
从仓库根 `bun <runner> <patched-cli>` 运行；须同时配置匹配的 patched SDK。
CC 的 child/provider renderer 联测与 Compact/statusline 联测在 `claude-style/`，
入口为 `PI_BIN=/path/to/pi bun integration/claude-style/child-ui.mjs`、
`PI_BIN=/path/to/pi bun integration/claude-style/context-compact.mjs`。这些矩阵保留原有断言及额外依赖，
不属于 stock 降级门禁。原 statusline 文档中的旧命令位置以本页为准。
