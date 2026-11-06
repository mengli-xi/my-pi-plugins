# pi-package-manager

`/plugins` 为 Pi 打开一个专注的 package manager。它同时管理 `getAgentDir()/settings.json` 和 trusted project 的 `.pi/settings.json` 中的 package。

## 功能

- 搜索和筛选已配置 package。
- 管理菜单复用 UIKit 的 accent 标题线和右对齐键位底线，作为 editor-slot overlay 打开。高度不超过 terminal 的 70% 与 editor slot 的可用高度；筛选和选择不跳动。外部左键只关闭当前面板并吞掉该次点击，列表区域的滚轮移动选择，详情区域的滚轮滚动 metadata。
- 跨 global 与 project scope 启用或停用整个 logical package。
- package 被停用时备份其 resource filter，正常启用时精确恢复。损坏或不匹配的备份拒绝恢复；缺备份则要求额外确认，确认后才会对缺备份的 entry 启用包允许的全部资源，有效备份仍照常恢复。
- 查看 source、scope、installed path、version、description、repository 和声明的 Pi resource。
- 通过 Pi 导出的 `DefaultPackageManager` 手动检查 update，并更新选中的一个 npm 或 git package。
- 修改 configuration 或 package 后 reload Pi。

首个版本有意不支持 install、remove 或 auto-update package。Pi 原生的 `pi install`、`pi remove` 和 `pi config` 仍是恢复路径。

## 按键

| 按键 | 操作 |
| --- | --- |
| `↑` / `↓` | 移动选择 |
| `/` 或 `Ctrl+F` | 搜索 |
| `Tab` / `Shift+Tab` | 切换 filter |
| `Space` | 启用或停用选中 package |
| `U` | 检查所有 package 的 update |
| `u` | 检查并更新选中 package |
| `r` | 修改后 reload |
| `Esc` / `q` | 关闭 |

manager 会阻止在 UI 中停用自身。若确实要停用 manager 本身，请使用 Pi 原生 `pi config`。

## 操作边界

`/plugins` 无参数，仅支持交互式 TUI。入口只注册命令，UI 与 catalog 在首次打开时加载；它不向模型注册工具，不调用模型，也不定时联网。

- 打开、筛选和查看 metadata 不检查更新。`U` 会通过 Pi 查询更新；`u` 在确认后通过 Pi 执行 npm/git 更新，可能运行第三方安装脚本。没有检测到更新不等于证明最新版，离线、固定版本或查询不可用都可能没有结果。
- 启停影响同一 logical package 的 global 与 trusted-project 声明；相对路径跟随各自 settings scope，agent directory 由运行中的 Pi 提供。不读未受信任 project 的 packages，也不修改其配置。
- 备份位于 `<agent-dir>/pi-package-manager/disabled/`，包含原 package source/filter，属于本地运行数据，不随源码迁移。新写入的备份只允许当前用户读写。不要删除仍需恢复的备份；损坏时保留原件并报错，不自动覆盖。
- 同 scope、同 source 的重复声明会在写入前被拒绝，避免覆盖彼此备份。需先整理 settings 中的重复项，本面板不自动合并。
- 配置写入复用 Pi；跨 global/project 两个文件不是事务，失败可能部分生效。报错后按实际 settings 检查，不承诺整体 rollback。reload 由用户确认；取消 reload 不撤销已写配置。
- 本地路径包不能在这里更新，Fork 的上游 merge 也不归本包。恢复路径是 `pi config`；更新 package 使用 `pi update <source>` 或 `pi update --extensions`，不要把单独的 `pi update` 当成 package 更新命令。

## 开发与验证

TypeScript 直接加载，无 build 或 dist。先在相邻 `pi-li-uikit` 安装其开发依赖，再在本包执行：

```bash
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm run check
```

使用官方 Pi 1.5.0，在隔离 HOME/config/cache 中验证，不动日常 settings。单测使用临时 settings 和假 package manager，不执行真实网络更新、安装脚本或模型请求。真实 npm/git 更新、终端/鼠标/IME 与完整 profile 需另行验收，RPC 仅验证非 TUI 入口会拒绝打开，不能冒充 TUI 验收。

## 日常回归 case

- `/plugins` 打开后搜索、切 filter、上下移动；检查窄屏、滚轮、详情滚动及外部点击关闭，退出后恢复 editor 输入/IME。
- 在隔离 agent directory 和 trusted project 中配置同一包的两套 filter，停用再启用；确认两处精确恢复。未受信任 project 不参与。
- 破坏备份后尝试启用：应报错且 settings/备份不变；删除其中一份备份后取消额外确认：两处均不变。确认后仅缺备份的 entry 放开过滤，有效备份仍精确恢复。
- 同 scope/source 重复声明不应产生备份或配置写入；不同大小写的 Git 仓库路径不应合并。
- 离线按 `U` 不显示“全部最新”；本地路径拒绝更新。需要真实更新时在独立测试环境操作并确认目标 scope，不用日常 package 验证。
- 修改后取消 reload，检查配置已写但运行中资源未重载；确认 reload 后再检查实际加载结果。
