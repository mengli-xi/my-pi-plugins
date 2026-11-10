# BTW 请求与面板

`/btw <question>` 通过 Pi 公开 `ModelRegistry.complete` 发起一个无工具、独立 request ID 的请求，继承 Main 的上下文快照并添加 one-off question boundary。不写 Main transcript，不继续 Main 的任务，也不重放 Main request-policy hooks。Main 首轮前允许空历史；模型与 thinking 来自当前 Main，provider/auth 使用公开 registry composition。

## 提交与显示

命令 dispatcher 不等待 provider 或面板关闭。提交后立即打开 editor-position browser，显示 pending；完整答案到达后原地替换，不要求用户再执行一次 `/btw`。同一请求使用稳定 identity，pending 不算已读答案，绘制完整 answer body 后才清除未读标记。

同时最多一个 BTW 请求，完成历史最多20条、仅在内存。宽度至少96列时问题与 Markdown 答案并排；更窄时先列问题，Enter进入详情，Escape逐层返回/关闭。选中项、焦点、滚动与每条答案的阅读状态独立，resize 不改变选择，新结果不强制跳走。

Main 可继续后台工作。Side 正占前台或打开中时，BTW 等 terminal ownership 交回 Main，再打开面板，不能抢 Side 的 stdin。用户主动关闭面板不取消请求；完成后不强制重开，可给不含正文、不取焦点的短提示，再用 `/btw` 查看。非 TUI 不创建面板。

## 取消与生命周期

`/btw cancel` 取消当前请求，撤下 busy 状态并移除 pending，不发成功通知。请求失败先关闭 pending 面板，再在 Main 显示错误，避免错误被旧答案盖住。失败、取消与 session replacement 不得产生旧请求的成功提示。Main session replacement 清空 BTW 历史、read state 和 view，abort旧请求；迟到结果不得污染新 generation。面板订阅和关闭 signal 随 view 释放。

Main/Side 的草稿和上下文不因 BTW 浏览而改变。问题与答案会作为独立请求发送到当前 provider，仍有 token/费用；“不写 Main transcript”不等于“没有发送上下文”。OpenAI Responses 只将 Main lineage 用作 `prompt_cache_key`，不共用 session/request ID，不承诺远端 cache 命中。
