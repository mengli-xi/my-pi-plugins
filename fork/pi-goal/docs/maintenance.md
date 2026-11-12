# 构建、验证与维护

[返回包入口](../README.md)。本地补丁的 **WHY** 见 Fork [LOCAL_PATCHES.md](../LOCAL_PATCHES.md)。这里只写当前兼容边界，不登记验收次数、迁移流水或 benchmark 结论。

## Fork 与依赖边界

上游来源与固定 tag、commit、子目录记录在 [UPSTREAM.json](../UPSTREAM.json)。原版位于主仓库 `vendor/upstream` 分支的 `fork/pi-goal/`，本目录维护本地补丁。升级流程见根 [贡献规范](../../../CONTRIBUTING.md#fork-维护规则)。
活动 Goal workspace 是 `fork/pi-goal`。根 workspace 和唯一根 `bun.lock` 统一依赖；只在根 `bun install --frozen-lockfile`，不在 Fork 另装依赖或维护第二份 lock。共享库在 `local/`，不作为 Pi extension 启用。TypeScript、Node types 和 Pi development baseline 由根管理；保留 Fork 原有 Biome 检查，不给整个根仓库新增 formatter 或升级 TypeScript。

Goal 使用 npm `@narumitw/pi-tui-kit`，当前锁定 **0.40.0**；本目录不包含该共享库的源码。

公开基线是 stock Pi 1.5；生产行为依赖公开 extension/session/context/custom-message API，无 Goal 私有 probe 或 host patch。外部 npm 包、vendor 中仅取 `extensions/pi-goal` 的原版和当前本地补丁包是不同测试对象，不能互相代替验证。

## 构建与轻入口

按[根安装说明](../../../README.md#安装与加载)在仓库根安装依赖，再构建并加载：

```sh
npm run build -w @narumitw/pi-goal
pi -e "$PWD/fork/pi-goal"
```

Bun 将薄 `src/index.ts` 及实现编译为 `dist/index.js` 与 dynamic chunks；Pi peers/typebox 保持 external。`pi-session-inject/mailbox-v1/light` 保留同步身份/producer/命令注册，把 engine/store 留到首次使用加载；splitting 不能被“简化”为全量 eager bundle。共享 transport 的 process-wide namespace/promise 负责跨 extension 复用。

`dist/` 不提交，没有 install/prepare 自动构建保证。改 Goal 或任何内联 source-only 共享库都显式 build，再用新 Pi process 验证，不能仅 `/reload`。恢复时 pending transport 仍须 awaited，轻入口不能改变 Goal accounting、owed、ACK 或取消语义。

## 检查边界

仓库根的标准入口是 `npm run typecheck`、`npm test`、`npm run test:integration`。Goal 包内 `check` 是包内 Biome、边界、typecheck 与测试，不等于整个仓库 gate，也不能充当 runtime/matrix evidence。各入口的覆盖范围和依赖以根 [integration](../../../integration/README.md) 为准。

本包只测试自身，不加载 Processes/Subagents/CC/Compact；共享库合同及 Goal domain/lifecycle 的离线测试，与 stock binary faux smoke 分开。跨插件 mailbox/tree、双加载顺序、paused results、分离 cutoff、崩溃/恢复和 status/clock 联测放 `integration/goal/`。测试使用临时 profile/session 和 faux provider，不调用真实 provider，不发现用户日常安装。构建后的 stock smoke 需要显式 Pi binary，版本必须与已安装 SDK 一致。

构建后，从根在隔离父环境运行本包 stock/faux smoke（证据目录不放仓库）：

```sh
export PI_GOAL_TEST_BINARY=/absolute/path/to/stock-pi
GOAL=fork/pi-goal
OUT=/absolute/path/to/evidence
node "$GOAL/test/goal-runtime-smoke.mjs"
node "$GOAL/test/mailbox-runtime-smoke.mjs" "$OUT/mailbox-runtime"
node "$GOAL/test/mailbox-a1-matrix.mjs" "$OUT/own-matrix"
node "$GOAL/test/mailbox-owed-fork-smoke.mjs" "$OUT/owed-fork"
npm run test:ui -w @narumitw/pi-goal
```

`test:ui` 用虚拟 PTY 和本地 faux provider 驱动真实原生 TUI，检查菜单、草稿、默认 settings、取消/替换、暂停/恢复和完成；不操作物理终端。真实 CC 的版本由根 `test:integration:goal-ui` 入口另行验证，包内不加载 CC。

binary 必须是实际文件的绝对路径，隔离环境的 `--version` 必须与已安装 SDK 一致，不 fallback 到个人 HOME/bin。runtime helper 以 PATH/NODE_OPTIONS allowlist 建立临时 HOME、agent、XDG 和 TMP 环境，保留调用方的 offline guard，不继承 credentials；SDK runner 的父环境也须由隔离 harness 提供。package native matrix 保留正常续跑、USER 顺序、budget、abort、crash/restart、source origin、fork 与 legacy cases；owed-fork 使用本地 faux producer，不因此变成真实 Processes 联测。真实 joint 的两种加载顺序见根 integration。

单元通过不代表完整 profile、人工 TUI、真实 host 或离线回退通过。缺 binary/协作方/构建产物时应报告未验证或明确失败，不伪造成功、不用源码 mock 代替编译入口。package metadata/distribution 改动还需 npm pack dry run；运行时加载改动需 fresh-process load，保持与实际 `pi.extensions` 一致。

## 规则附录与读取成本

`<getAgentDir()>/goal-append.md` 由宿主管理，用于在 active Goal rules 附近协调 scope 和验证策略，不属于 objective，也不是项目可覆盖的 settings。缺失/空白不追加；暂停 context 必须始终排除 active rules、guard id 与附录。路径遵守 runtime agent identity，不能写死日常 profile。

每次构造规则先检查 path 与 `dev/ino/size/mtimeNs/ctimeNs`，版本不变时复用已 trim 的文本（含空文本），变更后在下一 provider-request context 重读。默认路径每次从真实 getAgentDir() 取，不缓存 agent identity。仅接受 regular file，stat/open/read 的版本复核避免替换窗口，非阻塞 open 防止被替换成 FIFO 后挂住。

missing/空白不追加；stat/read 故障会丢弃旧 cache，不带回 stale text。非 ENOENT 故障只报告 operation 与白名单 errno，不显示正文、原始 error message 或真实目录。应用层在 TUI/RPC 发 warning，无 UI 时写 stderr、不写 stdout；连续相同故障去重，成功后可再次报告，session_start 重置去重。不追加 transcript，不增加 provider turn，也不因附录故障停止 active Goal。验证范围包括缺失、创建/修改/atomic replace/删除、空白、agent identity、故障/恢复和非 regular file；这些行为说明不代表测试已经通过。

## 更新审计

修改前读 [开发约束](extension-conventions.md)、[设置约束](extension-settings.md)，并服从根 [CONTRIBUTING.md](../../../CONTRIBUTING.md)。本地明确例外：中文文档、根 workspace/one lock、built splitting entry、现有 scoped Pi peers，以及默认关闭的无版本 managed RPC 兼容接口；不为符合上游展示偏好而删除支持语法或改名协议。

上游 merge 后重点重查：terminal tools/current-id guards、settled/request context、user/custom 边界、queue freeze、clockRunning/queueFrozen owner authority、source lineage、取消 barrier、legacy reader 与恢复 hold。检查必须限定在 Goal 范围；不要为让 gate 变绿而降低行为断言。
