# 贡献规范

改这个仓库前读完本页。本页只写硬规则，细节在各包自己的 README 和 `docs/` 里。

## 仓库里放什么

- 只放插件逻辑、共享库和必要的测试。迁移记录、验收流水、运行产物、一次性 benchmark/measure 脚本不进仓库。
- `local/<pkg>/` 是一个包。包分两类：
  - **插件**：注册 Pi extension，用户可以单独启用或不启用。
  - **共享库**：不注册 extension，只被插件 import（如 `pi-runtime-contracts`、`pi-session-runtime`、`pi-session-inject`、`pi-li-uikit`）。
- `host-patches/` 放 Pi 宿主的源码补丁，固定上游版本，不自动安装。
- 内部环境的适配（公司 provider、私有配置）不进仓库，放独立的私有仓库，通过公开的扩展接口接入。

## 插件之间的关系

- **每个插件单独装都能用。** 另一个插件没装、没加载、加载顺序不同，本插件都不能抛错、不能取消操作、不能留下阻断后续请求的状态。缺了协作方，本插件静默降级或回退 Pi 原生行为。
- 插件只能硬依赖共享库，不能 import 另一个插件，也不能在 `package.json` 里依赖另一个插件。
- 跨插件协作只走能力协议（事件名或能力名带版本号，如 `xxx:yyy-v1`）。协议由提供方的 README 定义，使用方必须处理「没人提供」的情况。
- 不读别的插件的私有存储（目录布局、文件格式、session entry 的内部字段）。要用它的数据，就让它通过协议主动提供。
- 共享库和协议里不写死具体插件名。需要区分参与方时，由参与方自己注册身份。
- 新增或修改协议时，同步更新根 [README](README.md) 的能力协议表：协议名、提供方、使用方、缺失时怎么降级。

## 测试

- 每个包只测自己：离线单元测试、合同测试，加少量用 faux provider 跑的本包 e2e。包内测试不加载别的插件。
- 跨插件联测，包括「缺了某插件仍能用」的降级测试，放根目录 `integration/`。
- 测试不发真实 provider 请求，不改用户的真实配置、终端或剪贴板。
- 生产代码里不留测试开关（环境变量注册测试命令之类）。测试需要的钩子放测试侧的 extension。
- 没有被测试或构建引用的 fixture、脚本，删掉。

## 依赖与构建

- 根 `package.json` 用 workspaces 管理 `local/*` 和 `fork/*`，全仓只有一份根 `bun.lock`。安装用 `bun install --frozen-lockfile`；根 `bunfig.toml` 固定 `linker = "hoisted"`，让 node_modules 布局与 npm 一致，不用 bun 1.3 的 isolated 默认。
- bun 默认不执行依赖包的 install/postinstall 脚本；确实需要脚本的依赖，显式加进根 `package.json` 的 `trustedDependencies`。
- `typescript`、`@types/node`、Pi peer 的开发版本统一在根声明。
- 共享库用 workspace 内部依赖引用，不用 `file:../` 相对路径。
- 共享的测试加载器等工具只留一份，放根目录。

## 升级 Pi

在干净且已提交的工作区运行（需要 Node、Bun、npm、Git；CC 宿主检查还需要 tmux 和 Bun PTY）：

```sh
node scripts/pi-upgrade-check.mjs 1.6.0          # 只检查，不改当前工作区
node scripts/pi-upgrade-check.mjs 1.6.0 --keep   # 保留临时副本排查
node scripts/pi-upgrade-check.mjs 1.6.0 --apply  # 全部通过才更新版本与 lock
```

脚本先向 registry 核对根 `@earendil-works/pi-*` devDeps 的精确目标版本，再 clone 当前提交到临时目录（不使用硬链接；macOS 使用短路径，避免套接字和终端路径截断问题），只在那里改根 devDeps 并安装目标依赖。依次运行全仓 `npm run typecheck`、每个 workspace 包各自的 `npm run test -w <包名>`（每个包单独一条结果，不用根 `npm test` 的串行入口）、`npm run test:integration`，然后按 workspace 的约定名字发现私有 seam 检查，不维护包名清单。根目录工具脚本自己的测试和文档链接检查不属于 Pi 兼容性检查，不进入这个门禁。一项失败后继续运行其他可执行项；依赖安装失败则明确列出未运行项。结束时终端汇总包、步骤、失败项和原始日志路径，并将结构化报告写入打印出的 `report.json`。默认删除临时副本，但保留报告和原始日志；`--keep` 额外保留副本。

宿主检查只支持 macOS 与 Linux。`check:host` 入口本身没有总时限，等待上限在各子脚本里。

检查入口只用两个名字：

- `check:internals`：只使用已安装 Pi SDK 的进程内探针，不启动 `pi`。用 `scripts/isolated-agent.mjs` 隔离配置。
- `check:host`：启动真实 `pi`，统一经 `scripts/check-host.mjs` 传递 `PI_BIN`；缺省为仓库根 `node_modules/.bin/pi`，不用日常 PATH 上的 Pi。CLI 版本必须与已安装 SDK 一致。包可以串联多个子检查，失败后仍继续；该包需要的构建也放在入口中。公共 runner 在启动任何子命令前隔离 HOME、agent、session、XDG 和 npm 配置，不传日常 provider 凭据；子检查继续使用各自临时 profile 和本地 faux provider；macOS 使用短临时路径，避免 Unix 套接字长度限制。`PI_OFFLINE` 只禁止 Pi 的自动联网，不能冒充 provider 网络沙箱。

可单独运行 `npm run check:internals -w <包名>` 或 `PI_BIN=/absolute/path/to/pi npm run check:host -w <包名>`。当前检查范围与预期耗时如下；时间是量级，不是时限承诺：

| 包 | 进程内检查 | 真实宿主检查 | 耗时量级 |
| --- | --- | --- | --- |
| claude-style | 原型依赖目录 | 构建、宿主类身份、子视图重试、本地模拟 provider 错误、状态栏命令、PTY 快照、完整历史 | 数分钟；单次 RPC/画面等待通常最多半分钟 |
| rewind | `SessionManager` 修改接口探针 | 同一探针装入真实 Pi | 秒级；宿主进程上限半分钟 |
| skills | `user-message.render` 探针 | 同一探针装入真实 Pi | 秒级；宿主进程上限半分钟 |
| terminal-focus | 光标渲染结构、终端生命周期、聚焦输入 | 同一探针装入真实 Pi | 秒级；宿主进程上限半分钟 |
| side-chat | 无 | 子视图实例探针 | 秒级；宿主进程上限半分钟 |
| cc-memory | 无 | faux provider、冻结 system、compact 与 resume | 数十秒；单次等待上限约一分钟 |
| session-compact | 无 | faux provider、压缩与恢复材料、有效上下文 | 数十秒；单次等待上限半分钟 |
| mcp-adapter | 无 | 构建、真实 CLI 启动及其 SDK 依赖图加载生产 dist | 数十秒；子进程上限半分钟 |

这些检查不调用真实 provider、不读取或修改用户日常配置。没有 `check:host` 的包（Subagents、Goal、Processes、Session Inject 等）只在各包 real/native 套件和根 `integration/` 的 `test:integration:*` 里跑真实宿主测试，不属于这个门禁，升级后要另行运行。这些检查也都不证明真实 provider、人工终端与输入法、没有探针的私有行为兼容。`test:patched-host` 及补丁联测不纳入原版宿主门禁；**只要 Pi 版本改变，`host-patches/` 必须按[补丁 README](host-patches/pi/v1.5.0/README.md#回滚升级与边界)重新 pin 上游及 hashes、重新构建和验证**，不能把旧补丁直接套到新版。

全部检查通过后，`--apply` 在临时副本里更新 `local/*` 的 Pi peers 和 `bun.lock`，再核对当前 HEAD 与工作区没有变化，仅复制根 devDeps、这些 peers 和 lock 到当前工作区；不安装到当前工作区，也不更新日常 Pi。只改写 `^X.Y.Z`、`~X.Y.Z`、`X.Y.Z` 这类简单范围；`*`、`>=`、`||` 并集保持原样并写入报告的人工处理项。`fork/*` 的 Pi peers 一律不改，只列进报告；如按目标版本修改，须同步记入该 fork 的 `LOCAL_PATCHES.md`。审查 diff 后自行提交，正常开发仍使用 `bun install --frozen-lockfile`。当前版本自检可运行 `node scripts/pi-upgrade-check.mjs 1.5.0`，它需要 registry/安装网络，不放入 `npm test`；升级工具在其中只运行离线单元测试。

## 文档

- 三层，逐层链接，agent 从上往下只读需要的那层：
  1. 根 [README](README.md)：包索引（每包一行）、插件与共享库的区别、能力协议表。
  2. `local/<pkg>/README.md`：用途、加载与构建、配置与命令、可选协作与降级、验证；末尾列出本包 `docs/` 里每份文档讲什么。
  3. `local/<pkg>/docs/*.md`：完整合同，如持久化格式、投递协议。
- 每份文档都要被上一层链接到；不能有断链。根目录的链接检查会在测试里跑。
- 同一件事只在一处写全，别处只放链接。
- 文档写当前状态。不写迁移流水、审批状态、测试通过数、commit hash、「本轮/上一轮/未迁入」。保留数据格式兼容与升级规则、备份恢复说明、复现所需的上游固定版本，以及仍在解释当前设计的 ADR；已被推翻的 ADR 删掉。
- 文档用中文；代码标识符、命令、协议名保留原文。改代码时，同一个 commit 里更新受影响的文档。

## Fork 维护规则

- `fork/<name>/` 只放一个上游包，源码直接纳入主仓库，与 `local/*` 共用唯一根 lock；不另建仓库或子模块。
- 原版只通过 `node scripts/fork-upgrade.mjs <fork> <版本或tag>` 导入 `vendor/upstream`，不在 vendor 分支手改。vendor 与主分支使用相同目录；git 来源仅展开指定子目录，npm 仅展开 tarball 的 `package/`。
- 每包必须有 `UPSTREAM.json` 和 `LOCAL_PATCHES.md`。后者说明每个本地补丁为什么存在、升级时必须保留什么。Fork 插件同样遵守上面插件之间关系的全部规则。
- `UPSTREAM.json` 为 JSON 对象。git 来源记录 `type: "git"`、`repository`、`tag`、完整 `commit`、`subdirectory`，脚本下载 GitHub codeload 时补充 tarball 的 `sha256`。npm 来源记录 `type: "npm"`、`package`、`version`、`registry`、`tarball` 和 registry 元数据的 SRI `integrity`；下载必须通过完整性校验。可选 `exclude` 为包内文件路径列表；以 `/` 结尾的是目录前缀，其余为精确文件路径，不支持 glob。它只排除上游随包发布的生成物或与本仓库无关的文件，不能用来藏本地改动。vendor 导入及逐字节自检都使用「原版减去 exclude」；来源记录不是上游发布内容，比对时单独排除它。
- 先保证工作区干净，并在主工作分支运行脚本。普通 clone 只取得当前分支时，先从克隆来源取得 `vendor/upstream` 分支（例如 `git fetch origin vendor/upstream:vendor/upstream`）。脚本不配置 remote、不切换工作区，用临时 index 在 vendor 上提交并 merge 到当前分支；来源记录随 merge 同时更新双方。可从仓库子目录调用；下载期间工作区或当前 HEAD 改变时拒绝提交，vendor 更新使用旧值校验，避免覆盖并发更新。`--dry-run` 只下载、校验、展开并报告相对 vendor 的文件差异，不提交，也不写 Git 对象库。仅来源记录或首次导入参数显式指定的 `file:` registry/tarball 可用于离线验证；registry 元数据返回的 tarball URL 必须为 https，不能授予本地文件读取权。
- 升级流程：跑脚本 → 手工解冲突并 `git add` / `git commit` → 逐项按 `LOCAL_PATCHES.md` 复查 → 跑 `npm run typecheck`、`npm test`、`npm run check:goal`、`npm run test:integration`。冲突时脚本停止并列出文件，不自动选择任何一边；`git merge --abort` 只撤销当前 merge，已导入的 vendor 原版保留；再次升级前先执行 `git merge vendor/upstream`，解冲突并提交完成这次合并。vendor 与当前分支无共同祖先、或当前为 detached HEAD 时，脚本明确拒绝。

- 新 Fork 的目录和来源记录都不存在时，也由同一入口首次导入：`node scripts/fork-upgrade.mjs pi-example 1.0.0 --npm example`，或 `node scripts/fork-upgrade.mjs pi-example v1.0.0 --git https://github.com/owner/repo.git --subdir extensions/example`。需要排除文件时重复传 `--exclude dist/ --exclude CHANGELOG.md`；npm 可显式传 `--registry <url>`，离线验证再传 `--tarball file:///absolute/path/package.tgz`。脚本生成 UPSTREAM.json，在 vendor 提交单包原版并合入当前分支，之后编写 LOCAL_PATCHES.md 并提交本地补丁。已有 Fork 的来源或 exclude 变更在 UPSTREAM.json 中修改并提交，不用首次导入参数覆盖它。
