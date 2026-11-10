# 本地 patch 意图

上游包：`@juicesharp/rpiv-ask-user-question` 2.15.0。上游源码：<https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question>。

本页解释差异为何存在，不保存升级、审批或测试执行记录。当前用户合同从 [README](README.md) 进入。

## 让用户先看懂问题

问卷会占用 editor 区域，用户不一定能同时看到前面的聊天内容。结构合法却抽象的问题仍然无法作答，所以保留一个必填的顶层 `context`，不把 schema 拆成多套背景字段。它必须说明用户当前所见/所做、选择的实际影响和当前任务的例子；不放内部推理、路径或未解释的术语。合同见 [工具参数](docs/tool-schema.md)。

## 区分讨论、解释和答案

单选的 `Chat about this` 用来质疑假设、补充遗漏或讨论方案；`Explain More` 用来要求模型立即解释，不先反问「哪里不懂」。两者都不是答案，也不是拒答。Chat 直接返回讨论请求；TUI 为各题保留独立的 Explain 草稿，不能借用或污染 `Type something.` 草稿。上下文和选项描述帮助模型解释用户真正要做的决定，不把这些材料重复塞进常驻 schema。交互见 [键盘与布局](docs/keyboard.md)，结果见 [工具参数与结果](docs/tool-schema.md)。

## 把渲染成本留到真正需要时

启动时不安排 prewarm，也不在空闲计时器里 import 问卷渲染图，避免刚进入会话时主线程卡顿。代价是首次真正打开 TUI 时等待加载。本地运行期间不要替换依赖；升级先退出相关 Pi process，再修改依赖并重启。仍保留上游加载失败 envelope，不能把用户未见到的问卷记成拒答。

并发 cold call 必须等待同一个进行中的加载 promise，避免 loader 暂时返回尚未完成的 namespace 后误报 `stale_module_cache`。只合并进行中的加载，结束后释放 promise，不永久缓存失败。详细边界见 [加载与性能](docs/startup-performance.md)。

## 不放宽源码运行要求

Pi 直接加载 `.ts`。保留真实 `.ts` 相对 import，避免不必要的 fallback resolution；构造函数显式声明字段并赋值，不使用 Node strip-only 拒绝的 constructor parameter property。不为方便测试切换到 transform-types 或新增 build 产物。

## 尊重宿主和用户的选择

工具需要用户参与，保持 `exposure: "model-only"`：模型可以直接调用，codemode/script 不应在执行到一半时打开阻塞问卷。无 UI 时只隐藏工具，绝不自动重新加入：公开 API 没有 selection revision，UI 恢复不能证明执行授权仍有效。同一 SDK session 切回 UI 需 Host/用户显式 `setActiveTools`；新 session 按初始 selection 初始化。不能改动兄弟工具。快捷键校验、只读配置和配置缓存都在本包边界处理，不靠别的插件补齐。合同见 [宿主](docs/hosts.md) 和 [配置](docs/configuration.md)。

上游 inline、滚动预算、overlay fallback、digits/Kitty、notes、原生回执、参数预处理、组合多选、未答提示和外部 answer/verdict 是本包的基础能力，不应被旧 overlay 实现或旧结果格式覆盖。已有无版本事件名按 [legacy 兼容合同](docs/events.md) 保留；新协作不能借兼容之名添加插件硬依赖。
