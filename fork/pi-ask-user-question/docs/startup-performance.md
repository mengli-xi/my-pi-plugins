# 加载与性能边界

## 不做启动 prewarm

工具注册只准备参数、guidance、事件和宿主协调，不 import 问卷 session/render graph。空闲等待也不安排 prewarm timer。首次真正需要 TUI 时才加载；RPC 原生 dialogs 和无 UI 路径不加载这张渲染图。

这样避免启动后突然在主线程同步求值渲染图，但首次打开问卷会有一次加载等待。这里不承诺固定毫秒数；机器、Pi loader、依赖和 cache 都会改变耗时。

## 合并并发 cold load

首次加载尚未结束时，其他 TUI 调用复用同一个进行中的 promise，等待模块完成求值，而不是把暂时不完整的 namespace 当成旧 cache。成功或失败后都释放该 promise；不永久记住失败。后续调用仍遵循宿主 module cache 的行为，不能靠合并保证坏 cache 在进程内恢复。

保留 `session_load_failed` 与 `stale_module_cache` 两类 envelope，见 [hosts.md](hosts.md)。本包不通过 timer 提前掩盖失败，也不让模型把加载失败读成用户拒答。

## TypeScript 源码边界

Pi 直接通过 loader 加载已发布的 `.ts`。相对 import/export 指向实际存在的 `.ts`，不依赖先尝试不存在的 `.js` 再 fallback。首次使用才需要的外部编辑器等模块继续在调用时加载。

Node strip-only 不支持 constructor parameter property。构造函数先声明字段，再接收普通参数并赋值；保留可见性、readonly 和默认值，不改为 transform-types 来绕过源代码约束。本包不生成或提交 `dist/`。

## 怎样回归

在隔离环境用新 process 检查以下边界，不用 `/reload` 或旧模块 cache 代替：

- 工具注册和空闲期间不加载 questionnaire graph，也没有 prewarm timer。
- 首次真实 TUI 调用可到达 custom UI；RPC/无 UI 仍不触发该加载。
- 并发 cold call 等待一次完整求值，不误报缺少 session class。
- import 抛错和缺少 session class 仍分别分类，失败后不留下未释放的 in-flight promise。
- strip-only 能加载整个 view graph；相对 import 指向真实文件。

包内测试只测本包，跨插件和缺协作者联测放根 `integration/`。日常交互步骤见 [regression-cases.md](regression-cases.md)。需要记录性能时保留当时的宿主/Node、场景、原始样本和 cache 条件到外部工作记录，不在本页沉淀一次性 benchmark、通过数或历史延迟结论。

## 更新依赖

先退出相关 Pi process，再更新依赖并重启。运行中的依赖目录被替换可能污染 loader cache；禁 prewarm 并不消除这个风险，也不把原地替换依赖变成受支持的热升级方式。
