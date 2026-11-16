# Goal 设置开发约束

本页约束设置实现；当前字段与行为见 [Settings 合同](configuration.md)，公共开发规则见 [开发约束](extension-conventions.md)。

## 文件、作用域与兼容

- 配置由本包拥有 loader、validator、UI、持久化与兼容逻辑，不复用其他插件的私有存储。
- 当前配置是 `<getAgentDir()>/pi-goal.json`，不支持项目覆盖。使用 Pi 公开目录接口，不拼接 home，不直接读取 agent 环境变量。
- 缺文件表示使用代码默认值，读取不创建文件或目录。既有 config/alias 只按兼容合同保留；新 UI 使用 Settings，不注册与 Pi 冲突的通用 `/settings`。
- 不为偏好项新增环境变量，也不把每个 JSON 字段镜像成环境变量。

## 校验与持久化

- 顶层必须为对象，运行时校验字段。无效文件应报告并阻止覆写，不能用默认值覆盖损坏文件。
- 保存从最新有效文档修改拥有的字段并保留未知字段。写入用同目录临时文件加 rename，不用硬链接发布。
- 读写是同一并发协议：顺序保存、读前等待已排队写入、失败后队列仍可用；退出或 reload 前等待 durability。进程内队列不等于跨进程锁。
- 保存失败保留原文件与有效值，UI 回滚并通过当前模式可观测的通道报告；存储 helper 不直接污染 JSON/RPC/TUI 输出。
- session_start（含 replacement 与 reload）重载。文件名兼容时优先 canonical，迁移须避免覆盖并发创建或删除已变更的旧文件。
- 设置输出不泄露秘密。如未来确需凭据，禁止放项目源码配置，私有文件权限为 0600；不在状态、错误或日志打印内容。

## 交互与测试

- TUI 使用真实 SettingsList 与宿主 theme，支持既有搜索、键盘和 Escape；自由文本用编辑器。即时保存不能把 Escape 描述成事务回滚。
- 每次修改按用户顺序应用与持久化；保持 generation/session guard、失败回滚和取消释放。
- RPC 可通知手动编辑路径；print/JSON 不能以 notify-only 声称可观测支持，也不尝试 custom UI。
- 测试涵盖无副作用的缺失读取、首次保存、正常与损坏文件、未知字段、原子写失败、保存串行化与回滚、session 重载，以及相关兼容行为。配置字段与有效时间同步到 Settings 合同。
