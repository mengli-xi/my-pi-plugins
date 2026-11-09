# pi-effort

`/effort`：一个 Claude Code 风格的选择器，用来设定模型回答前的推理强度。

Pi 1.5 已有原生 `/thinking`、`Shift+Tab` 和 `/settings` 入口。这个包提供熟悉的 `/effort` 命令、共享滑杆、可点击的状态栏档位，以及有条件贡献主动委派提示词的 `ultra`，不替换 Pi 的底层推理协议。

```
────────────────────────────────────────────────────────────────────────────────────────────────

 Effort

       Faster                                                                    Smarter
       ──────────────────────────────────────────────────────────────────▲──────────────
       off        minimal        low        medium        high         xhigh         max
                                                      Extra-deep reasoning (~32k tokens)

 ←/→ to adjust · Enter to confirm · Esc to cancel

────────────────────────────────────────────────────────────────────────────────────────────────
```

## 使用方法

| 输入 | 效果 |
|---|---|
| `/effort` | 打开滑杆，光标位于当前生效的级别；点击 statusline 中的 effort 也会打开同一面板 |
| `/effort high` | 直接设置，不打开滑杆 |
| `/effort hi`、`/effort x` | 可使用无歧义前缀；`m` 不可用，会提示它可能表示的三个级别 |
| `/effort 5` | 设置为滑杆从左起第 5 个级别 |
| `/effort none`、`/effort maximum`、`/effort mid` | 分别是 `off`、`max`、`medium` 的别名 |
| `/effort ultra` | 设置当前模型的最高真实档位，并在条件满足时贡献主动委派提示词；不是模型新增的档位 |

在 `/effort ` 后使用 Tab completion，会列出**当前模型**支持的 canonical 级别及其描述，不展示兼容别名。模型尚未解析时返回空候选，不猜测可用档位。

在滑杆上，可用 `←` / `→`（或 `h` / `l`、`↓` / `↑`、`j` / `k`）移动光标；数字键按当前列表的位置跳到级别（最多 8 档）；`Home` / `End` 跳到两端；`Enter` 确认；`Esc` 取消。光标到达两端时会停住而不是循环：从 `max` 再往右却跳到 `off`，显然不是提高强度的预期。确认前不会应用变更，光标下方的说明会展示当前指向级别的含义。说明中的 token 数字仅作近似参考，不保证所有 provider 使用相同预算；实际请求映射由 Pi 和模型决定。

每一帧都会重新计算布局，因此滑杆打开后仍能适应终端 resize：标签会尽量分布到整个面板宽度，按键提示会缩写为 `←/→ · enter · esc`；如果面板窄到连单空格间隔都放不下，则回退为 `◀ medium ▶`，按键保持不变。

## 颜色

每个级别都有独立颜色。光标、轨道已填充部分和下方标签共用该颜色，因此移动一档时变化一目了然，而不仅是光标位置改变：

| | | |
|---|---|---|
| `off` | 灰色 | 不进行推理 |
| `minimal` `low` | 蓝色、青绿色 | 冷色端 |
| `medium` | 绿色 | |
| `high` `xhigh` | 琥珀色、橙色 | 推理增强 |
| `max` | 品红色 | |

当 Pi theme 为每个 thinking level 都提供不同颜色时，会直接使用 theme 的颜色；Pi 自带的 `dark` 符合这个条件。许多 theme 会让多个级别共用同一个值，最常见的是除 `off` 外全部相同；只有一次跳变的渐变不如不用，所以此时采用上表的色阶。没有 truecolor 的终端使用对应的 256 色近似值。

## 它修改什么

它修改的就是 `Shift+Tab` 和 `/settings` 中 `thinkingLevel` 所修改的设置：Pi 的 thinking level，也就是另一种命名下的 reasoning effort。变更作用于下一轮，并写入当前 session history，resume 后保留；Pi 1.5 不会因此修改新 session 的默认值。

该 package 拥有 statusline 中 `effort` slot 的文本和点击动作；`pi-claude-style` 只负责 slot 布局与命中路由，statusline producer 只输出 `[[pi:slot:effort]]` marker。点击和 `/effort` 复用同一个 picker，不另建一套 selector。

滑杆只显示当前模型实际支持的级别。`xhigh` 与 `max` 只对能映射它们的模型存在（GPT-5.x、部分 Gemini 和 Doubao 版本），其他位置不会显示；完全不支持 reasoning 的模型没有可选项，命令会明确说明而不是打开空面板。session 中途切换模型时，列表也会随之更新。

参数解析会拒绝当前模型未提供的档位；如果模型在解析与应用之间改变，Pi 仍可能 clamp。命令会报告实际生效的级别，不把请求档位当作成功结果。

在 TUI 外命令仍可用：RPC host 使用 Pi 的纯文本 selector；在 `-p` / `--mode json` 中，应使用参数形式（`pi -p "/effort high"`），因为没有地方显示 picker。

## 安装

```bash
pi install /path/to/my-pi/local/pi-effort
```

也可以将路径加入目标 `<agent-dir>/settings.json` 的 `packages`，安装相邻 workspace 的 `pi-li-uikit` 依赖后新开 Pi process。本包没有 build；若更新了内联 UIKit 的消费者，须按其构建约定重建，不用 `/reload` 替代 rebuild/restart 验收。本包的相对 `file:` 依赖不代表它能脱离 workspace 独立发布到 registry。

## 绘制方式

面板是一个每帧自行渲染的 component，而非预先构建的 row 树，因为轨道起点、光标位置和说明位置都取决于 viewport 宽度。

行按可见列而不是字符串长度组合：文本在放置前已经带颜色，因此用 `visibleWidth` 测量；放不下的片段会被舍弃，不会把同一行其余内容挤偏。任何 row 都不会超过面板宽度，测试覆盖了七种宽度。

边框使用 Pi 的 `DynamicBorder`，只绘制顶部和底部，与其他 selector 一致。

## 测试

在隔离 HOME/config/cache 中安装官方 Pi 1.5.0 锁定依赖，不读取日常配置：

```bash
npm ci # 在仓库根运行
npm run typecheck
npm test
```

命令测试使用 Pi stand-in，不调用真实模型。提示词汇总器、真实 provider 和人工 TUI 需要另行验收；不能用单测代替实际部署证明。

测试覆盖级别阶梯（模型可用级别、参数解析、前缀、位置、别名和歧义情况）、滑杆（间距与居中、轨道覆盖标签、光标落在自身标签内、箭头/数字/Home/End、两端 clamp、确认、取消、针对不同/扁平/近似扁平 theme 的选色、七种面板尺寸下的行宽、窄面板回退），以及使用 Pi stand-in 测试命令本身（设置、拒绝、clamp、picker 往返、无 UI / 无 reasoning 路径，以及随模型切换变化的 completion）。

## The `ultra` rung

The ladder carries one rung pi does not have. pi's `ThinkingLevel` is a closed
union (`off … max`), so `ultra` is presented by this package rather than passed
to `setThinkingLevel`:

- it pins the **model's top real level** — whatever that is. It does not require
  `max`, so every reasoning model can offer ultra;
- it contributes a proactive-delegation fragment to the system prompt over
  `prompt:fragments-v1` (owner: pi-model-prompts).

**Picking `max` and picking `ultra` are different acts, and only `ultra`
can contribute a fragment.** An explicit non-ultra `/effort` choice, or a real
level change through Pi's native selector, leaves ultra. Pi 1.5 does not emit a
change event when the same native level is selected again; use `/effort max`
(or another plain level) to explicitly leave ultra in that case. The flag is
per session, persisted as a `pi-effort:ultra-v1` custom entry, so it survives
reload/resume/fork and follows rewind.

The prompt owner must also be explicitly loaded. Without `pi-model-prompts`,
the command can change the real thinking level but cannot add the fragment to
a model request. The fragment goes to the current provider as part of the normal
system prompt; this package does not send a separate request or launch agents.
The default wording respects user instructions and existing approval/tool
permissions. Selecting ultra grants no additional authority.

### The violet ripple

While the caret rests on `ultra`, a violet ripple spreads across the panel from
that rung's caret: concentric rings of background colour, brightest at the
wavefront, fading through an eight-step gradient behind it. The animated field
fills every cell between the title and footer rules, including blank space on
both sides, but never paints or crosses either rule.

The geometry and timing are Claude Code's own `/effort` slider, read out of its
shipped bundle rather than guessed — 8 steps from `rgb(62,22,118)` to
`rgb(140,80,240)`, a 20-column wavelength, 0.03 columns per millisecond,
repainted every 80ms. Two details carry the look and are worth keeping if it is
ever tuned: distance weights rows twice as heavily as columns (a terminal cell
is about twice as tall as it is wide, so without it the rings render as tall
ovals), and the ring profile is a raised cosine rather than a hard edge, which
is what makes the wave roll instead of march.

It starts when the caret arrives, restarts from zero each time it comes back,
and stops when the caret leaves or the panel closes. Cells the wavefront has
not reached keep their normal colours, so the panel stays readable throughout.
Confirming a level plays nothing — Claude Code has no confirm-time animation
either, just the notification.

Implementation notes: `ripple.ts` is pure (distance, gradient step, and an
ANSI-aware per-cell painter that preserves the theme's foreground escapes and
resets only the background), so the whole effect is tested without a terminal.
The panel owns a raw timer, which pi does not tear down for extensions the way
it does event subscriptions, so it is cleared on leave, on select/cancel, and
on `dispose()`.

### Gating on the sub-agent tool

Telling a model to spawn sub-agents when no such tool is registered is how runs
derail, so the fragment is injected only when the configured tool is in the
turn's confirmed toolset (`selectedTools`). Missing, malformed or unknown
toolsets fail closed. Without confirmation the session stays ultra, contributes
nothing, and warns once per ultra activation (reset on session change). Switching ultra on also does a best-effort check that
the configured package is enabled in settings.

### Configuration

`<agent-dir>/pi-effort.json`:

```json
{ "ultra": { "subagentTool": "spawn_agent", "subagentPackage": "local/pi-subagents" } }
```

`<agent-dir>/ultra-prompt.md` overrides the contributed text; a missing or blank
file uses the shipped default. Each use checks inode/size/mtime/ctime and reuses
unchanged bytes and parsed config, including cached failures. Editing, replacing
or deleting a file is observed on the next use without rewriting any config.

Missing config uses defaults. Invalid config or unreadable config/prompt files
disable contribution and emit one safe diagnostic per failed version; they do
not silently enable a default delegation policy. Diagnostics include the file
and failure context, not file contents. The real thinking level remains set.
The mode switch is contributed, while delegation instructions stay in the
`subagents` skill. Custom overrides remain the operator's responsibility and
must respect existing permissions.

`<agent-dir>` is Pi's public `getAgentDir()` (`PI_CODING_AGENT_DIR` when set). Pi 1.5.0 is required.
