# Goal 开发约束

本页保留适用于 Goal 的上游开发规则；全仓硬规则见 [贡献规范](../../../CONTRIBUTING.md)，设置细节见 [设置约束](extension-settings.md)，包入口见 [README](../README.md)。

## 包与依赖

- 本目录只放 Goal。`src/index.ts` 是薄 default factory 入口，实际加载 `dist/index.js`；修改源码后显式构建并以新进程验证。
- 运行库放 dependencies，Pi 宿主包与 typebox 放 peerDependencies；发布内容与 files、许可证、入口保持一致，修改分发配置后检查 npm pack。
- 不能 import 或硬依赖另一个插件，不能假定其安装、顺序或私有数据。共享库可以硬依赖；跨插件协作走版本化能力协议，消费者缺席时安全降级。
- 标准多屏操作优先复用已安装的 UI 库；领域状态、确认、事务和 session authority 仍由 Goal 拥有。不要为拆文件机械拆分大模块。
- Biome 限定本包：tab、100 列、双引号、分号和 recommended lint；工具版本由仓库根管理。

## 生命周期与权限

- 模块求值与 factory 注册阶段不启动 session 后台任务。进程、timer、watcher、server 首次使用或 session_start 才启动。
- 取消、组件 dispose、session replacement、shutdown 分别审计；部分初始化和重复清理都安全。每次 await 后重新校验 session、generation、signal 和可变 authority。
- reload 后旧 continuation 立即返回，不复用旧 context。session replacement 只能从有权的命令 handler 调用。
- 状态跟随 active branch 持久化并在 session_start 重建，不能把 sibling branch 的历史当当前授权。
- 工具执行错误应抛错，支持取消，限制返回文本；同路径写入需串行化。插件是可信同进程代码，不是沙箱。

## 命令、TUI 与状态

- `/goal` 无参数打开管理菜单。既有直接命令是公共接口，不能仅为 menu-first 偏好删除；文档、parser、补全、模式与安全检查保持一致。
- 未知参数与尾随输入明确拒绝。非 TUI 模式执行可支持的直接操作或可观测拒绝；RPC notify 不等于 print/JSON 有输出。
- 只有 TUI 才调用 custom UI。组件渲染不得越宽，主题缓存可失效，交互后请求 render，Input/Editor 转发 Focusable；异步 UI 必须在 dispose 和用户取消时释放资源。
- 破坏性操作展示准确摘要并确认，取消不改变状态。使用 callback 提供的 theme/keybindings，避免循环重开 select 导致导航丢失。
- 状态与 widget 使用稳定包级 key，关闭、替换和初始化失败时清理确切 key。显示活动与需处理状态，不常驻 ready；不能依赖 presenter 的存在。

## 文档与验证

- 文档用中文，写当前使用合同，不保存迁移或验收流水。小改动只采用相关规则，不扩大成全包重构。
- 行为修改同步确定性测试；命令测试覆盖声称支持的模式，生命周期测试覆盖取消与恢复。包内不加载协作插件。
- 运行根 typecheck、test、check:goal、integration；分发配置改变补 npm pack 检查，运行时加载改变补新进程 smoke。报告未验证的边界，不用静态检查冒充 runtime 结果。
