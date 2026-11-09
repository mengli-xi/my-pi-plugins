# pi-subagents · 界面合同

## 1. 单一 presentation

Main above-editor strip、/subagents editor panel 和 statusline 只消费 ui/agent-presentation.ts 的纯 agentPresentation(snapshot,execution)。不由时间/width/theme 改变分类或排序，也不复制 domain state。既有 UIKit EditorPanel/TabStrip/theme token 格式和 Pi native view 保留；Main editor/history/draft 原 instance 不重建。

| 分类 | 条件/标签 |
|---|---|
| Running/running | starting/running，或 waiting 已拿 active execution；starting 单独 label |
| Running/waiting | parked Task；activation_order 存在时另标 activation queued |
| Running/queued | admitted/queue head 或未完工作尚未执行 |
| Running/closing | lifecycle closing，优先于其它 group |
| Done | 无未完 Task/queue，idle 或 closed，显示 latest outcome 或 idle |

unavailable 是附加 label，不把未完工作挪 Done。queued ×N、closed、unread 也是独立 label。保留不匹配 tab 的 muted 祖先，子树按最优匹配 row 排序；Running group 顺序 running→waiting→queued→closing，order 取 activation/admission/created revision；Done unread 优先，然后 latest completion/close 时间倒序，再 Agent ID。tab count 只计真实 matching Agent，不把 muted 祖先重复计数。选中 ID 跨 reorder 不变，删除选最近邻，tab 在 dialog/refresh 后保持。

标题 open N/配置上限。底栏/statusline 同一 tuple：agents N · running N · waiting N · queued N · unread N，可另带 closing N。counts 按 Agent，queued 标签可显示 Task 数但底栏不能逐 Task 计数；Running tab 含全部 work group，不同于 actual running。unread 以 appended Inbox ID 去重，row 可同时关联 producer/recipient，底栏只算一次。cache 包含完整 tuple、Host revision 和 terminal width。

## 2. 列表操作

| 输入 | 行为 |
|---|---|
| Tab/方向键 | 切 Running/Done 与行选择，保留选中 ID |
| Enter/点击 | 打开 native Agent conversation；失败不标读 |
| X | 仅 interrupt current Task；queued-only 提示无 current，保留后续 queue |
| C | idle 子树直接 close；busy 先显示 Task/descendant 计数、Cancel 默认，再显式 Force close；带 lifecycle revision 防 stale |
| D | 删除确认/target revision；已完成 open 子树先 close/drain，再重验 revision 与持久 delivery/cleanup 条件，可明确包括 unread；未完工作不隐式 force，未收口不删 |
| R | 只 closed 行显示，resume 目标 idle，零 Task/provider，保留 unread/draft |

列表鼠标消费 UIKit `EditorPanel.getRenderedItemAt(row,column)` 的最后成功 frame 可见稳定 ID；坐标为 panel-local，实际 filter/scroll offset 后行、截断 label 仍指向同 ID。input/invalidate/失败/closed/非 item/越界无命中，disabled/muted/已不存在 Agent 拒绝。不能用 task-name substring 推断点击对象或清错 Agent 的已读。

M/F Main 编辑器 message/followup 路由删除。窄窗口保 name/status，frozen model/effort/full metadata 放既有 detail row，不重复发明 layout。/subagents [target]补全同 runtime snapshot，含 closed path/ID，empty/partial/unknown 均验证。

## 3. Native conversation 与直接输入

每次进入创建 native InteractiveMode，CC 显式 factory init 前 attach，返回 await admission/commands drain→detach→stop→headless rebind。execution 保留，Main 原 TUI 仅暂停，TerminalOwner 确保全 process 单 stdin；Main/Side/Agent view 不并存前台。closed/unavailable 历史用 in-memory SessionManager 投影，不启模型/写原 history；浏览复制零 provider。

Enter 经 InputPolicy immediate→admitViewInput：idle 新 user Task，busy/starting/selected queued 同 Task durable steer，waiting 申请 active 位，保留依赖和 owner/deadline。Alt+Enter 传 after-current→FIFO 新 user Task，不能当 steer/interrupt。starting 期间匹配 current Task/runtime generation 的正常 active 装配也允许 durable FIFO；unavailable 历史 runtime 继续拒绝，不把装配中的 execution 当历史不可用。普通 Enter 不进入 native followUp queue。request UUID 与 Host receipt 幂等，durable 成功才清 editor 并入 history；失败保 draft，不自行重发。inline toast 区分已接纳等待工具/执行位/压缩、已开始、已取消。

closed 可以编辑草稿，Enter/Alt 拒绝且零请求，提示“Agent 已关闭，先恢复再发送”。无参数/resume-agent 调用 Host resume，成功 open 后换 execution view，保留 draft；用户再次 Enter 才新 Task。R 与该命令同入口，32 open 满/closing/frozen drift 留 history 并报错。controller-local draft map 跨 return/assembly 保存。

允许/subagent /exit /quit 返回，/resume-agent、/copy /session /compact [instructions] /hotkeys /changelog /help；/model [text]与/thinking [text]只读冻结状态。自由 compact 文本 completion 为 null；closed 不能 compact。Alt+/返回；Ctrl+C busy 停 current 并留页、idle 返回，空 Ctrl+D 返回，非空 native delete；Ctrl+Z 及 Main 生命周期/model/effort 变更/external-editor/dequeue 受 policy 阻止。release/repeat 仅过滤接管控制，其余 native 输入原样。

## 4. 当前已读规则

下列规则是当前实现的已读合同，用户可在切换评审后修订：

1. ManagedInteractive onLoaded 只在 native init/主题/draft 恢复成功后调用。进入 Agent thread 清**该 Agent 自产 Task 的 Completion 活动标记**，即使 Inbox 在 Main/其它 owner；不清它收到的 descendant 卡片。
2. 点击 Completion 只清该精确 card。现有 TextOpener=true 作为打开证明，CC lazy panel 实际 mount 是 async，不能据此声称精确 viewport 呈现。
3. close/resume/选行/failed 或 unavailable init/render 测量/scroll/model 消费不标读。

Host markCompletionsRead 验证精确 Inbox/Completion/projection digest/native entry ID，空/错/混入 invalid receipt 或写失败保 unread。人工 ui_read 与模型 turn settlement 完全分离。禁止根据 native render/offscreen tail 推断“用户看见”；无新增 CC onPresented/private viewport seam。

## 5. 主题与终端释放

公开 Pi API 与 stock Core 支持以 Pi 1.5.0 为目标，原版也可打开 managed native thread UI。
共享 [Runtime](../../local/pi-session-runtime/README.md#theme-watch-与原版降级) 在 Main stop 前核对
SDK root `THEME_WATCH_CAPABILITY` 与真正 Main native `ExtensionUIContext.themeWatchCapability`：
双面均为 `"pi.theme-watch.file-version.v1"` 时保留完整 patched 热更新路径；双面都缺失时允许
交接，沿用交接时配色，不依赖主题文件热更新、不装 repaint bridge，native init 后及返回时避免
重复 `setTheme` 同名主题。原版可能显示旧配色，首次打开会给一次 warning，说明安装
[补丁宿主](../../host-patches/pi/v1.5.0/README.md) 可获得热更新。
仅一面声明或任一未知值仍明确拒绝相关 UI、保留 Main；不能用 shim 补 marker。
该能力不授予 tools/model/provider 权限，也不是 provider/OS attestation。

Patched SDK 独占 selected user-theme JSON 的 file-version watcher、loader/cache 与 palette 通知，
不扩大 package/project hot-reload 范围。Runtime 的 cache-only repaint bridge 不读/parse 正文，
不新增 theme loader、不 private import；patched 路径不按 name 相同跳过恢复。CLI 与 canonical
SDK 必须使用一致补丁 peer graph，具体合同见 Runtime 与 host patch 文档。

当前只支持显式单个命名主题（如 profile 显式指定的命名主题），自动 pair/匿名 theme 在暂停 Main 前拒绝。listener 按 public process 引用差集清理，不能移除 Main handler；close 输入/command drain 防重复提交。stable Host interrupt 在 headless/reload 后可用；quit 只释放不重启 Main。Side 额外 configureMode/visibility、emptyDelete/external terminal yield 不改变 Subagents Task policy。

CC presentation 可选，缺席时使用 Pi 原生消息渲染；本轮不迁入、不提交 Processes/CC，仅在目标外使用真实源码构建产物作所需测试依赖，不算它们验收。缺依赖如实拒绝/记未验，不删除视图功能，也不把 Completion 单行 fallback 当完整视图。上述 patched UI host 的 TTY/faux 回归须覆盖宽/窄、mouse/keys、single stdin、closed draft/resume、precise read、Main 还原；IME/physical kitty/SSH、真实 provider、全 profile、人工 TUI 和 10/32 长历史性能均未验收，见 TEST_PLAN。
