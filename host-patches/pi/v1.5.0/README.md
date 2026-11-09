# Pi 1.5.0 主题监听补丁

这是 **`pi-1.5.0+theme-watch-file-version-v1` patched build**，不是原版 Pi 1.5.0。SDK 的 upstream package version 仍为 `1.5.0`；构建根目录的 `host-patch-build.json` 另记 build ID、输入及输出 hashes、Node/npm 版本。这里只维护 source patch、构建/检查脚本和 focused tests；不提交 `node_modules` 或 `dist`，不安装到日常 Pi，不部署或 push。

## 上游和唯一源码

`manifest.json` 固定官方 tag `v1.5.0`、commit `f9a26365568127461c47a07a37dcb42c140a3ac5`、GitHub archive SHA-256、关键 pristine source/lock/build-script hashes。只下载该 commit 的 tarball；不 clone、设置 remote 或修改旧 repository。

`source.patch` 是唯一 theme 修复源码，只有四个 upstream TS 文件：

- `theme.ts`：复用相同实际 user-theme 文件路径和选择名的 watcher owner；`fs.watchFile` 每 200ms 只比较 `dev/ino/size/mtimeMs/ctimeMs/nlink`；版本没变不读/parse 正文。沿用原 100ms debounce、loader、registry cache、palette commit 与每次显式 `setTheme` 的 UI notification。
- callback/timer 都检查 owner identity 和当前选择；旧 timer 先 fence，再触碰共享 timer。stop 先退役 owner，再取消 timer，只移除自己的 callback。切换、in-memory theme、失败 fallback 都清理旧 owner；同 target 重应用不 teardown、不丢 pending reload。
- 只观察 runtime `getCustomThemesDir()` 中首次监听时已存在的 selected user-theme JSON；不扩大 package/project theme hot-reload 范围。路径保持词法身份，支持 symlink 目标替换。坏 JSON、暂时删除保留最后有效 palette，重建后继续观察。
- 另外三个文件只公开 root marker、NativeUI optional readonly 类型与原 UI 创建处的实际字段。

没有第二份手写 theme loader/parser 或 bundle 实现。上游 TypeScript 同时生成 JS、`.d.ts` 和准确 source maps；上游 `scripts/build-coding-agent-bundle.mjs` 从同一编译输出生成完整真实 CLI bundle（不是只修 unbundled SDK）。

## 公开合同与所有权

Provider 是本 **Pi host patch**；consumer 是 **`pi-session-runtime` managed UI**。

| 独立证明 | 公开接口 | 必须精确等于 |
| --- | --- | --- |
| canonical SDK | root export `THEME_WATCH_CAPABILITY` | `"pi.theme-watch.file-version.v1"` |
| 真正 Main native CLI | 当前 `ExtensionUIContext.themeWatchCapability`，`readonly` optional | `"pi.theme-watch.file-version.v1"` |

consumer 必须分别核对两面；双面均缺失时允许原版 managed handoff，但沿用交接配色、首次提示主题文件热更新降级，避免重复同名 setTheme。仅一面声明或任一未知值仍拒绝 managed handoff。root marker 不能代替 native CLI 的证明；NativeUI 字段也不能代替 canonical SDK 的证明。非 interactive mode 不冒称支持 native handoff。消费者不得 import Pi private path/prototype；这里的内部 focused tests 属于 provider 自测，不是 consumer contract。

## 可复现构建

需要 Node `>=22.19.0`、npm、tar、patch；检查还需要 Python 3 和可用 PTY（当前验证平台为 macOS）。所有输入、输出显式传入；`WORK` 必须由操作者选在 repository/日常 Pi 以外。不要把示例变量改成真实 agent/session 目录。

```sh
PATCH=/absolute/path/to/host-patches/pi/v1.5.0
WORK=/absolute/path/to/new-isolated-build-work
mkdir -p "$WORK"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://codeload.github.com/earendil-works/pi/tar.gz/f9a26365568127461c47a07a37dcb42c140a3ac5 \
  -o "$WORK/upstream.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.5.0.tgz \
  -o "$WORK/pi-ai-1.5.0.tgz"
node "$PATCH/build.mjs" \
  --archive "$WORK/upstream.tar.gz" --model-data "$WORK/pi-ai-1.5.0.tgz" \
  --output "$WORK/build" --install-deps
node "$PATCH/check.mjs" \
  --sdk "$WORK/build/source/packages/coding-agent" --output "$WORK/check-1"
```

`--install-deps` 是明确同意在新输出内执行构建依赖 `npm ci --ignore-scripts`，不是安装/更新用户 Pi 或下载插件。缺此 flag 的 fresh build 会拒绝执行。依赖使用上游固定 lock，公开 `registry.npmjs.org`；子进程环境不继承真实 HOME、agent、XDG、npm config/cache、临时目录或凭据，所有这些目录位于显式 output 内。命令不发现用户现有配置。

GitHub source archive 没有 `pi-ai/src/providers/data`。脚本只从 SHA-256 固定的官方 `pi-ai@1.5.0` npm tarball 取 `dist/providers/data`，先由上游 `check:model-data` 校验其 catalog/manifest，再走官方根命令 **`npm run build:offline`**。不在线重新生成浮动 model catalog，不复制 npm theme JS，也不替换上游 build 流程。

输出中的 SDK 为 `build/source/packages/coding-agent`，真正 bin 为它的 `dist/bundle/cli.js`。**完整保留 `build/source` workspace 与它的 `node_modules` 解析图**：coding-agent、pi-tui、pi-ai 及其它 workspace peers 全由这次同版本源码构建。不能只覆盖 coding-agent 而保留另一套 pi-tui/pi-ai，也不能只换 CLI 让 SDK consumer 继续读旧 SDK。消费者切换补丁宿主时，由 Main 显式装配全部 peers；本脚本不改任何外部 link。

重复运行同一命令会核对 receipt 和全部已记录输出 hashes；匹配则 skip，不改写。输入 hash 不符、非 pristine source、已有未完成 output、输出发生漂移或 patch 改变均明确拒绝，必须选新 output。不要在 output 内手改生成物。依赖安装失败也保留证据，不会自动删掉或覆盖半成品。

## 定向验证

`check.mjs` 每次使用新的显式 test output，并为各 case 建独立 HOME/agent/XDG/cache/tmp；不读真实凭据，不发 provider 请求。测试包括：

1. canonical public root 和真正 CLI theme chunk 的真实 FS 测试：稳定版本不重复读、inplace、atomic rename、坏 JSON/恢复、delete/recreate、symlink/目标 atomic rename、built-in 切换。
2. unbundled/bundle 两组确定性 lifecycle：100 次同名重应用仍通知且 watcher 只建一次；pending reload、同名 snapshot 恢复、A/B/A late callback/timer、stop、新 runtime agentDir、fallback 与 package-only scope。
3. 四个改动 TS 的 source-map `sourcesContent` 与源码逐字相等；`.d.ts` 的 optional readonly NativeUI contract；workspace peer 版本和真实 link 一致。
4. 从真实 `dist/bundle/cli.js` launcher 遍历可达图，确认 patched theme owner 和 NativeUI 创建字段确实可达；不硬编码 esbuild chunk 名。
5. fresh SDK root import、unbundled/bundle `node --check`；fresh **真正 CLI PTY** 加载仅使用公开 extension API 的 fixture，在 `session_start` 读取 `ctx.ui.themeWatchCapability`，同时断言 `mode === "tui"`、`hasUI === true`，随后公开 `ctx.shutdown()` 退出。

结果写在显式 test output 的 `result.json` 和各 case log；NativeUI 的独立证据在 `smoke/native-ui.json`。如果 native CLI 没有真实字段，即使 root marker 存在也失败。

还可在相同隔离环境运行 upstream `npm --prefix <build>/source/packages/coding-agent test -- theme`。这只是 upstream theme 子集，不是完整 SDK suite。

## 回滚、升级与边界

- 回滚由 Main 恢复先前记录的 **pristine artifact/完整 peer graph links**，再启动 fresh Pi process；不能只恢复一个 JS 或只回退 CLI。CLI 与 SDK 双面均无 marker 时 consumer 允许主题降级的 managed handoff，并给一次提示；只回滚一面仍因 marker 不一致而拒绝。
- 不删除或改写任何 session、agent、auth、config 数据。保留旧 pristine artifact 及链接记录，直到新 build 全量 fresh 联验完成。本脚本不做部署或自动 rollback。
- 升级必须重新 pin 官方 commit/archive/source hashes，审查原 theme lifecycle 与 public contract，再重新构建和验证；禁止把此 patch fuzz apply 到别的版本，或只补 marker 假装修复仍在。
- 200ms poll + 100ms debounce 是 nominal 设置，不是繁忙 event loop 的硬 deadline。metadata 无法识别所有字段都刻意保持不变的内容替换；本修复没有为此增加轮询 digest/第二 loader。
- 定向测试不能代替完整上游 suite、其他 OS/网络文件系统、真实 provider 或人工终端验证。升级后用正式 SDK/CLI peer graph 重跑消费者与真实 UI runner。
