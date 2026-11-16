# 运行合同

本页说明 Main 与显式 SDK child 的安装和能力边界。工具和命令入口见 [README](../README.md)，可选 backend 见 [backend 合同](backends.md)。

## 配置

配置格式、开关、读取和写入规则见 [配置](configuration.md)。

## 显式安装与 snapshot

默认入口只安装 Main，不靠环境变量或进程身份猜测 child。Host 可以显式安装：

```ts
installSearch(mainPi, {
  child: false,
  config: configSnapshot,
  agentDir,
});
```

Main 拥有命令、设置持久化、状态展示和 child capability 声明。Main 可以根据本包配置调整自己的 active tools，但保留无关工具。

SDK Host 从 `extensions/child.ts` 的 named export 获取 factory：

```ts
const childFactory = createSearchChildFactory(configSnapshot);
// 将 childFactory 交给 Host 的 SDK extension assembly。
```

也可直接调用 `installSearch(childPi, { child: true, config: configSnapshot })`。`SearchConfigSnapshot` 对外只读；factory 和每次安装都复制配置，Main、child、兄弟 child 不共享可变的配置对象。Main 后续写入或切换 model/tree 不会让已安装的 child 读取并采用新配置。child 使用自己的执行 context 获取 provider、model 和凭据。

child 只注册工具与必要执行逻辑，不注册 `/search`、设置 UI、配置写入、状态展示或另一份进程级 capability owner。child 不调用 `setActiveTools` 修改 Host 冻结的 active-tool allowlist；哪些工具暴露给模型由 Host 决定。snapshot 里的开关仍限制工具执行，即使 Host 允许了工具，也不会绕过本包禁用配置。

## 可选 child 能力

Main 通过 `pi-runtime-contracts/child-capabilities-v1` 共享 registry 声明 owner `pi-native-search`。`pi-subagents` 与 `pi-side-chat` target 使用 `extensions/child.ts` 作为 descriptor，`activation` 为 `required-only`，公开工具为 `web_fetch` 和 `web_search`，不声明 child 命令或 provider。`createRegisteredSearchChildFactory` 适配共享 options，创建时读取并复制配置，并显式接收父 backend emitter；声明同时冻结 `extensions/index.ts` 的执行 SHA。完整声明/校验规则只写在 [child 合同](../../../local/pi-runtime-contracts/docs/child-capabilities-v1.md)。

Main 负责绑定 session、更新 runtime generation 并在 shutdown 释放自己的 binding/registration。SDK child 不重新声明 owner，避免替换 Main 的 capability。没有消费者时 Main 工具照常可用；本包不加载 child Host，也不 import 它的插件实现。

可选 Main backend emitter 需要 Host 另外批准并显式传入，不能靠进程全局状态自动继承；接口与生命周期见 [backend 合同](backends.md)。
