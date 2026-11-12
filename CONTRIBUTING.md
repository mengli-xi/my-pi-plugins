# 贡献规范

改这个仓库前读完本页。本页只写硬规则，细节在各包自己的 README 和 `docs/` 里。

## 仓库里放什么

- 只放插件逻辑、共享库和必要的测试。迁移记录、验收流水、运行产物、一次性 benchmark/measure 脚本不进仓库。
  - 例外：`scripts/bench/` 是可复跑的隔离基准，用来给优化做前后对比，所以留在仓库里；测量产物仍然不进仓库。
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
- 共享库和协议里不写死具体插件名。需要区分参与方时，由参与方自己注册身份。现有 ABI key 保持不变（如 `pi.subagents.process-wait-bridge.v1`/`v2`、`pi.goal.continuation-obligation.v1`），新协议用中性命名。
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

档位由维护者定，脚本只拦 `--quick` 的越界用法。

- 主版本、次版本走完整验收。
- 补丁版本先比对 dist 声明、loader/alias、session schema、探针涉及的私有接口和生命周期；涉及任何一项就走完整验收。
- 完全不涉及才可选快速档，并记录依据。`--quick` 只接受同一稳定 major/minor 的补丁升级或当前版本自检，不接受预发布或降级。

在干净且已提交的工作区运行，需要 macOS/Linux、Node、Bun、npm、Git；宿主检查按需使用 tmux/Bun PTY。

```sh
node scripts/pi-upgrade-check.mjs <版本>                 # 完整验收
node scripts/pi-upgrade-check.mjs <补丁版本> --quick      # 快速验收
# 两档都可加 --keep 保留副本，或加 --apply 在通过后写回
```

- 核对 registry 的精确版本，在无硬链接的临时 clone 中安装；不改日常 Pi。
- 所需生产包各构建一次，再跑 typecheck、全部包单测和 `check:internals`。
- 完整档再跑 `check:host`、`check:upgrade:*` 和[根 integration 场景](integration/scenarios.mjs)；定向入口只过滤场景，不重复执行。
- 快速档只再跑包声明的 `check:smoke`：宿主类/模块身份、实例探针、child retry、退出命令、最小 PTY 绘制边界，以及 native 信箱投递、取消和 branch/followup。
- **没有 `check:smoke` 的包在快速档完全不跑宿主检查**，例如 cc-memory、session-compact、scheduler，以及 mcp-adapter 的 dist 加载。
- 快速档不测 PTY 快照和历史、Goal/Processes/Subagents 之间的协作、持久恢复，通过也不代表完整兼容。
- 每套件单独计时、限时、清理；普通失败继续，收到中断信号则停止验收，清理后写报告。
- 失败、缺前提、环境限制和超时都算没通过；不自动豁免 EPERM，也不允许写回。
- 默认删除副本和配置，保留终端汇总、`report.json` 和原始日志；报告记录档位及未测范围。
- `--apply` 再核对 HEAD/工作区，只写回根 devDeps 精确版本、`bun.lock` 和 README 支持声明，不在当前工作区安装。写回后才收到中断时，文件已经改好，报告标为未通过，但 `applied` 为 true。

包自行声明检查，脚本不维护包名名单：

- `check:internals` 用 `scripts/isolated-agent.mjs` 跑进程内 SDK 探针。
- `check:host` 经 `scripts/check-host.mjs` 启动真实 Pi；`::` 分隔子套件，前置 `--require=tmux`/`--require=pty` 声明前提，输出实时分流记录。
- `check:smoke` 跑快速档宿主冒烟，沿用 host 的隔离和版本检查。
- `check:upgrade` 聚合本包 `check:upgrade:*` real/native 套件。独立运行前按包 README 构建。

- `PI_BIN` 相对仓库根解析，缺省为根 `node_modules/.bin/pi`；CLI 必须与已安装 SDK 同版。
- 宿主检查隔离 HOME、agent、session、XDG、npm 配置，只用 faux provider；`PI_OFFLINE` 不是网络沙箱。
- `npm test` 逐文件跑工具离线单测，限制嵌套进程并发，再检查文档并跑各包单测。
- 真实 provider、人工终端/IME、无探针私有行为不在自动保证范围。

peer 只检查是否覆盖目标版本，不验证最低 API。用到新 API 时，手动抬 peer 下限。fork 改范围还须更新 `LOCAL_PATCHES.md`。当前版本只在[根支持说明](README.md#支持说明)维护，自检将它传给同一命令。

stock 和 patched 分开交付。普通升级不要求重新 pin/构建补丁，原版子视图沿用主题热更新降级逻辑。旧补丁只适用于固定版本；选择新版 patched 时才按[补丁说明](host-patches/pi/v1.5.0/README.md#回滚升级与边界)重新 pin、构建和双侧联验，不纳入 stock 验收。

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
