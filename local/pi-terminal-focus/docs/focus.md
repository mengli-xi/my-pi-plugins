# pi-terminal-focus

`pi-terminal-focus` 在 terminal/tmux pane 失焦时隐藏 Pi fullscreen / regular TUI **主输入框**中的 fake cursor；重新聚焦后恢复。它不改变 editor 的逻辑 focus、draft、autocomplete 或输入路由。此行为不是原版 Pi 1.5 默认提供的能力。

终端或 tmux 必须支持并传递 DEC focus reporting；本包不自动改 tmux 配置，也不抢窗口焦点。

## 资源归属

- extension 通过 DEC focus reporting（`CSI ? 1004 h/l`）接收独立的 `FocusIn` / `FocusOut` sequence；包含相同 bytes 的普通输入或 bracketed paste 原样交还 Pi。
- extension 使用 public `getEditorComponent()` / `setEditorComponent()` 包装当前 editor factory，并返回原 editor 实例。它只在失焦帧中删除 public `CURSOR_MARKER` 及紧接的 `renderFakeCursor()` APC 包装，保留 cursor cell 文本；其他样式、字符、reset 和行几何保持不变。
- package 不拥有普通 terminal input，不改变 Pi focus tree，也不依赖 patched host。它包装当前 public `Terminal.start()` / `stop()` method：TUI stop 前关闭 focus reporting，start 后恢复；teardown 会恢复原 method identity。
- fullscreen viewport 提前消费 focus event；`compat/pi-1.3.ts` 观察 `TuiAltScreen.handleViewportInput` 后仍转交 Pi，保留 selection/gesture 清理。该私有 seam 用 `fullscreen.focus-input` probe 验证，失效时 warning。regular 继续使用 public `onTerminalInput()`。
- render shape 不匹配时 fail open，并通过 UI warning 报告一次；`npm run check:internals` 在 Pi 升级后验证该 seam。
- 控制序列写入同步失败时不把状态记为已切换，下次 bind/start/stop 可以重试；写入未抛异常只代表已发送命令，不代表终端确认生效。清理仍为 best effort，不阻塞原生 terminal lifecycle。
- editor 绑定失败时，每个 owner 最多尝试通知一次；原始错误作为 cause 保存在现有内存状态中，不把异常正文放入通知。通知 sink 已失效时不继续抛错影响输入，release/new owner 会清理该诊断。

## 范围

改变 fullscreen 与 regular TUI 主 editor 的 cursor presentation；overlay、`ctx.ui.input()` 和 Subagent child terminal 不属于本 package。regular/fullscreen mode switch 与 child terminal handoff 都经过同一 `Terminal.stop()` / `start()` lifecycle，因此 focus reporting 不会泄漏给 child，回到 Main 后会恢复。

## 生命周期

`session_start` 与 reload resource discovery 会幂等重绑 listener/editor factory。runtime 会跟踪装饰期间见过的 terminal；每次 TUI stop/start 都成对关闭/恢复 focus reporting。`session_shutdown` 会退订 listener、关闭 reporting，并恢复原 `Terminal.start()` / `stop()`；process exit 另有同步 safety net，避免 control sequence 泄漏到 shell。

## 验证

```sh
npm run check
PI_BIN=/path/to/pi npm run check:host
```

支持 Pi 1.5，TypeScript 直接加载，无 build/dist。验证前先按[根安装说明](../../../README.md#安装与加载)安装依赖；以下验证命令在包目录运行。

验证使用独立 HOME、agent/config/cache 与 session directory，不读取或改动日常 profile。单测和 source/final-host probe 只用假 terminal 捕获控制序列，不操作真实 tmux/终端，不调用模型。probe 不能替代人工 focus、IME 与 child handoff 验收。

修改后必须完整重启 Pi；不要用 `/reload` 验证 extension 源码变更。

## 日常回归 case（人工另验）

- 在支持 focus reporting 的独立测试终端，分别检查 regular/fullscreen：主输入框失焦隐藏、聚焦恢复；草稿、逻辑 focus 和 autocomplete 不变。
- 普通输入与 bracketed paste 中包含类似 FocusIn/Out 的 bytes 时，不应被吞掉或误判；overlay 和输入弹窗不在本包范围。
- 停止 TUI 或把 terminal 交给 child 前关闭 reporting，返回后恢复；退出后 shell 不收到残留控制序列。异常断开或强制终止不属于正常退出的保证范围。
- 与启用的 Rewind/CC Style 联合检查 editor identity、双 Escape、图片、IME 和焦点恢复，不用单包 fixture 冒充全 profile 验收。
- 写入同步失败后下一次生命周期调用可重试；editor 绑定失败给一次安全诊断，通知不可用也不阻塞输入。
