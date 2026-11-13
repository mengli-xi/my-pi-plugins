# Pi 宿主与视图合同

本包直接从 TypeScript 加载，基线为stock Pi 1.5。SDK装配、model completion、settings、session API、editor factory 与 UI callback 使用公开接口。Side 没有 OS child/PTY 后端；PTY只用于验证真实 Main 的终端交接。

## 私有 seam

仅保留两个 instance-only probe，历史文件名不代表当前宿主版本：

- `side-chat.child.render-session-entries`
- `side-chat.child.compaction-display`

它们位于 `compat/pi-1.2-side-visibility.ts`，仅对 Side instance 隐藏 inherited IDs、boundary 与 inherited compaction/live summary，detach恢复原方法；不改 Main prototype，也不从执行上下文删除对应背景。compaction 行为检查在 `compat/pi-1.2-compaction-probe.ts`：惰性摘要 getter 作为停止点，惰性构造前的 Markdown theme/transformer 查询由探针 receiver 的无副作用桩提供；同时验证原生 Spacer 和 summary 路径，不初始化真实 UI。probe失配必须在view初始化前拒绝，保留Main，不能猜测宿主结构后继续。

```sh
PI_BIN=/path/to/stock-pi npm run check:host -w pi-side-chat
```

源码检查不能代替实际宿主检查。没有 runner-capture 或旧进程模式 probe，也不自动修改 Pi 源码。

## 前台 ownership 与可选展示

同一时刻只允许一个 view 拥有stdin。Side打开期间Main保留草稿并拒绝submit；Side普通返回等待detach后恢复原Main editor/history与terminal状态。external editor用可取消yield，shutdown等待其结束。Main完成可在Side前台显示短提示，但不能抢回输入。

CC presentation为可选贡献；缺席时原生Side仍可使用，非法或漂移的已发布descriptor拒绝。共享 [Session Runtime](../../pi-session-runtime/README.md) 管理SDK realm、terminal lease和host capability：原版Pi允许命名主题交接并首次提示配色能力降级，不保证主题文件热更新。只有同次构建的补丁双面capability匹配时才启用热更新；单面/未知拒绝。Side不擅自打补丁，也不把展示能力当provider/tool授权。

## 验证边界

本包单元与BTW测试不加载协作插件。真实CC/Timeout/Processes协作与SDK PTY矩阵放[根 integration](../../../integration/README.md)，使用临时配置和faux provider。必须核对Main/Side独立草稿/模型/effort、十次返回、compaction可见性、销毁、BTW共存和terminal恢复；不能只看probe通过就宣称交接完整。

人工鼠标/IME、真实provider/cache、完整profile与长期内存/回收性能需另行验收。cooperative disposal不能硬杀任意JavaScript。
