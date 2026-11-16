# 配置

[返回包入口](../README.md)。

## 来源、加载与显示设置

Plugin 设置由 `<agent-dir>/extensions/pi-claude-style/config.json` 中的 `conf` store 管理。`<agent-dir>` 由 Pi 公开 `getAgentDir()` 解析，并遵守 `PI_CODING_AGENT_DIR`；不要假定固定 HOME 路径。应优先使用 `/cc-style config
get|set|reset <path>`，而不是手动编辑 JSON。重新加载 extension 后 renderer 设置才会生效；验证编译后的改动时请重启 Pi，因为运行中的进程会保留已加载的 extension module。

package 根目录的 `config.json` 是仍被 `src/config.ts` 消费的 legacy fallback：旧 `CONFIG_PATH` 不存在时会读取它。它不是现行 schema v6 的默认值清单，其中旧 `integrations` 不代表恢复 hosted loader；不要仅因字段已退役而删除该运行资源。

已有 schema v6 store 在启动时直接读取并经过完整的 document/字段校验，首次写配置时才同步加载 Conf 和它的依赖。
缺失 store 的首次创建、旧 schema 迁移和显式损坏恢复仍在原时机经 Conf 原子写入；损坏内容仍保留原字节并进入只读诊断状态。
Conf writer 单独打包为 `dist/config-storage.cjs`，通过同步 require 首次加载，兼容 stock Pi 的 compiled Bun host；主入口不静态导入该文件。

冷启动 UI 加载也在同一个 store 中配置。`loading.mode=balanced`（默认）让命令面板和 overlay 在首次使用时加载；`eager` 会在首个 context 和 `loading.idleDelayMs` 之后预热；`minimal` 禁止空闲预热。`loading.preloadOverlays` 和 `loading.preloadDiagnostics` 可将单独类别加入 balanced 预热。`/cc-style status|doctor` 显示 module 状态；`/cc-style perf` 报告 import 成本和用户可见的等待成本。

`maxGroups` 分别限制保留完整 payload 的工具分组数量和 completed Activity phase 数量，而不是现有行数；`maxCapturedBytes` 也分别限制工具参数/结果与 Thinking 正文的 UTF-8 bytes。payload 裁剪不能改变历史行几何；fullscreen history window 另按批次卸载、保留高度锚点，并在需要时重建组件。较旧的工具分组只释放参数/结果；较旧的 completed Activity phase 只释放完整 Thinking 正文并保留时间线骨架与明确的 `details released` 提示。active phase 永不裁剪。

`working.style` 可选择 `"cyber"`（动画彩色显示）或 `"plain"`。`working.spinnerIntervalMs` 控制 Claude 配色 spinner 的节奏，`working.refreshMs` 控制指标/shimmer 的刷新率，`working.messageWidth` 则是 spinner 两个固定行各自的宽度上限；实时终端宽度可以进一步降低该上限。第一行始终包含 headline。第二行始终包含状态：如有 provider activity 则先显示它，随后是必需的已用时间，再后是空间不足时按重要性丢弃的可选指标。headline 独立截断，两行绝不合并，即使所有内容能放进一行也是如此。安装后的默认值为 `"cyber"`、`180`、`120` 和 `100`。

## 配置与持久化

`ConfigService` 是运行时唯一配置入口；`<agent-dir>` 由 Pi 公开 `getAgentDir()` 解析，遵守 `PI_CODING_AGENT_DIR`。私有 store 是 `<agent-dir>/extensions/pi-claude-style/config.json`，只保存 schema version、revision、overrides 和 migration receipt；Pi package/theme/model/statusLine 设置仍归 Pi。

- 优先级为受支持的环境逃生开关、用户 override、默认值。命令区分 active/stored/pending/source；除已实现的性能开关外，展示变更需 reload/restart，不因能写配置就声称实时生效。
- 默认值/schema/catalog/范围与补全保持同一来源。未知字段保留但不激活；错误不打印敏感值。
- 已有 v6 store 启动时轻量读取并完整校验，Conf writer 首次写入才加载；创建、迁移、恢复通过完整文档原子写入，不逐字段写中间状态。canonical 内容已相同则不写。
- mutation 通过 revision/mtime 拒绝外部修改冲突，不承诺跨进程锁或自动合并。渲染、输入和流更新热路径不做同步文件 I/O。
- 损坏 store 保留原始字节并只读诊断；显式 `/cc-style config reset-all --force` 先移动到带时间戳同级备份再恢复。headless 普通 reset-all 需 `--yes`。
- 迁移幂等且保留原始字节备份/回执：schema v2 删除 integrations；v3 移除 session naming（v2 backup 供独立 owner 只读导入）；v4 的旧布局移交已被 v6 fullscreen 接管取代；v5 迁移加载时序；v6 导入 Pinned 的五个合法 fullscreen 键，已有 CC 值优先，源不改，备份失败进入只读诊断。
- package 根 `config.json` **仍是运行资源**：`src/config.ts` 在旧 `CONFIG_PATH` 不存在时 fallback 读取它。旧 `integrations` 例子不是当前 schema 默认，也不会恢复 hosted factory；不能按“旧字段”误删整个文件。

## Pinned 配置迁移

从 settings.packages 删除 pi-pinned-layout 后重启。CC schema v6 首次启动将 `<agent-dir>/extensions/pi-pinned-layout/config.json`（优先，overrides）或 `pi-pinned-layout.json` 的 enabled、stickyUserMessage、floatAutocomplete、popupGap、minViewportRows 导入 `layout.*`。已有 CC 值不覆盖、非法值跳过，源文件保留并写 `.cc-style-v6.bak`；CC v5 store 留 `.schema-v5.bak`。备份失败则诊断只读，不写迁移结果。以后用 `/cc-style config get|set|reset layout.*`，补全来自同一 catalog；重启生效。若 settings 仍加载 Pinned，CC fullscreen host 不安装并在 doctor 报 degraded。
