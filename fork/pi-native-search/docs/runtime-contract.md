# 配置与运行合同

本页说明 `SearchConfig`、Main 与显式 SDK child。工具和命令入口见 [README](../README.md)，可选 backend 见 [backend 合同](backends.md)。

## 配置格式与开关

Main 使用 `<agentDir>/search-config.json`：

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "providerOverrides": {
    "openai": {
      "searchEnabled": true,
      "fetchEnabled": true,
      "searchBackend": "native"
    },
    "example-provider": {
      "searchBackend": "example-search"
    }
  }
}
```

- `enabled` 是总开关；`searchEnabled`、`fetchEnabled` 分别控制工具。
- `providerOverrides` 按当前 `ctx.model.provider` 匹配。某 provider 的 `searchEnabled: false` 或 `fetchEnabled: false` 会进一步禁用对应工具；设为 `true` 不覆盖全局关闭。
- `searchBackend` 只选择搜索路由，不改变抓取。`"ddg"` 强制 DuckDuckGo；`"native"` 保留 provider 默认路由；其他字符串选择已注册 backend ID。未知 ID 保留 provider 默认。完整选择顺序见 [backend 合同](backends.md)。
- 顶层四个字段都必须存在；前三项必须是 boolean，`providerOverrides` 必须是对象。每个 override 也是对象，只允许可选的 `searchEnabled`、`fetchEnabled` boolean 和非空 `searchBackend` 字符串；未知字段会报错。
- 配置不存 API key、OAuth token、模块路径或 provider factory。

默认入口通过 Pi `getAgentDir()` 解析 agent directory。显式 Main 的 `agentDir` 决定配置位置；child 不自行发现或读取 Main 的文件。

## 读取、失败与写入

配置文件不存在时使用以下默认值，不仅为了读默认值就创建文件：

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "providerOverrides": {}
}
```

坏 JSON、字段类型错误或文件系统读取失败必须显式报错；不能吞掉错误后按缺失文件默认启用工具。Main 生命周期重读失败时会先关闭内存中的搜索和抓取开关，再抛错；默认入口首次读取失败则不继续安装。修复文件或权限后再读取。若要恢复默认配置，先备份原文件，再修复或移除它；不要依赖失败时自动覆盖。

读取只接受 regular file，可跟随指向 regular file 的 symlink；目录、FIFO 等特殊文件及 dangling symlink 均报错，不当作缺失配置。读取使用非阻塞 open 和文件身份复核，避免路径被替换成 FIFO 后阻塞启动。读取使用文件版本信号缓存已解析的配置；文件未变时不反复读内容和解析。Main 在 session/model/tree 生命周期更新配置时重新检查版本。缓存不存凭据，原生请求仍每次经当前 session 的 Pi registry 解析凭据。

写入只由 Main 发起：已有文件的规范化内容与待写配置一致时跳过；需要写入时先写临时文件，再原子替换，避免读到半份 JSON。写前先读取并校验原文件，不覆盖损坏或不可读的配置；读取和替换前发现版本变化也会报错，要求重试。读取或写入错误保留上下文，不用成功提示掩盖。保存前和替换前都拒绝 symlink，既不替换链接，也不写链接目标；使用链接时请在其目标文件中手工维护配置；要通过本包保存，须先把该固定配置路径恢复为实际文件。候选配置只有保存成功后才替换内存并调整工具开关，保存失败不会在内存中偷偷重新启用搜索。原子替换不等于跨进程事务，也不承诺合并多个 writer 的并发修改。

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
