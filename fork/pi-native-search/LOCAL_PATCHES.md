# 本地维护意图

上游：[smalibary/pi-native-search](https://github.com/smalibary/pi-native-search)，版本 `0.1.0`。本页只解释当前 Fork 为什么保留差异；使用与完整合同见 [README](README.md)。

## 不适配 Claude 订阅搜索

公共安装不应依赖另一个插件的内部 `node_modules`、模块布局或 CLI 登录。搜索和抓取不调用 Claude Agent SDK，不从 `pi-claude-bridge` 借 SDK，也不增加 SDK 依赖。普通 `claude-bridge` 和未知 provider 默认用 DuckDuckGo/HTTP；外部集成仍可通过公开协议贡献搜索 backend。

## 让 Pi 管理凭据

公共原生搜索保留 ZAI、Anthropic、Google、OpenAI、xAI 的 API。每次调用都经执行 session 的 Pi model registry 取有效凭据，让 Pi 负责 API key、OAuth 刷新和锁生命周期；本包不自行解析 OAuth 记录或缓存 token。

Anthropic 的直接 Messages 请求只支持 API key。有效凭据是 OAuth token 时退回 DuckDuckGo，而不是把它当作 `x-api-key` 发出。凭据状态只供展示，不代替调用时的有效凭据判断。

## 失败必须如实反馈

Pi 通过抛出的执行错误标记工具失败，不能靠不存在的 `AgentToolResult.isError`。搜索/抓取执行失败和取消要抛错；native-to-DDG fallback 成功要提示原失败，双重失败要保留两边上下文。取消后不继续 fallback，避免用户停止操作后又发出下一次请求。

## 配置不能因读写失败而意外启用

文件缺失可以使用默认配置，坏 JSON、错误字段或读取失败则必须 fail closed，而不是吞错后默认开启网络工具。版本未变时复用已解析配置；内容未变时不重写；有变化才原子替换，避免不必要的 I/O 和半写文件。配置目录来自 Pi 或显式 Host 参数，不猜用户的私人路径。格式与恢复方式见[配置与运行合同](docs/runtime-contract.md)。

## Main 与 child 各自拥有状态

同进程 SDK session 会共享 module cache，不能靠模块级状态或环境身份隐式区分 Main/child。显式 factory 为每个安装复制配置，child 的 model/tree 生命周期不重读 Main 文件，也不写回 Main 设置。

Main 独占命令、持久化、状态展示和 capability owner；child 只提供工具执行，不修改 Host 冻结的 active-tool allowlist，避免 child 重绑或退出影响 Main/兄弟 session。Main 声明 Subagents/Side 的开放 child factory，注册时冻结适配模块及实际执行文件，两个消费者共用 loader；不依赖某个消费插件存在。合同见 [child-capabilities-v1](../../local/pi-runtime-contracts/docs/child-capabilities-v1.md)。

## 可选集成只走公开协议

私有配置、传输与 provider 映射不能进入公共包。保留 `native-search:backends-request-v1` 同步发现协议，让可选集成主动提供搜索能力；没人响应时仍可使用公共原生 API、DuckDuckGo 和 HTTP。

严格校验描述符、拒绝重复 ID/default-provider，避免加载顺序决定行为。每次调用发现 responder，让加载、撤销和替换可预测。SDK Host 只能显式传入批准的 Main emitter，不能让 child 从进程全局状态偷用集成。完整合同见 [backend 合同](docs/backends.md)。backend 是同进程可信代码，不是沙箱；发现协议不直接传凭据不等于权限隔离。

## 当前兼容边界

- 使用原版 Pi 1.5.0 的公开 extension/SDK、schema 和工具结果合同，不依赖 Pi private seam。
- 本包 source-only，无 `dist/` 或 build；host 提供的 Pi API 与 `typebox` 按 peer 使用，避免重复 schema 身份。
- `/search` 的 parser 与补全共用公开子命令；无交互 UI 时用文本反馈，不让设置面板阻塞 RPC/非交互调用。
- 输出截断只限制 HTTP 抓取返回的正文，不承诺下载量、独立超时或 SSRF 防护。fallback 也不承诺无额外请求或费用。

## 上游维护

来源与完整性见 [UPSTREAM.json](UPSTREAM.json)，原版保存在主仓库 `vendor/upstream` 分支的同路径。升级使用根 [贡献规范](../../CONTRIBUTING.md#fork-维护规则) 的脚本与复查流程；原版发布记录留在 vendor，本目录文档只描述当前合同。
