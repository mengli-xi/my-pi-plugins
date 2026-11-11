# 外部 SDK provider 工厂

## 发现与 ABI

通过 child capability registry 发现，不按品牌/包名识别 provider。存储 ABI 2 使用 `Symbol.for("pi.child-capability-registry.v2")`、version 2、operationVersion 2、brand `pi-child-capability-registry-v2`。V1 export/type 名和 manifest/register/bind/snapshot DTO 仍为 V1。

ABI 1 cell 保持隔离、不覆盖；旧 register closure 不能校验扩展 schema，也不能给新 manager 授权。发布方须解析当前共享库，编译消费者须重建。外部可独立发布 ABI 2 supplemental owner，与旧 ABI 1 provider 任意顺序共存。ABI 2 key 上出现坏/ABI 1 shape 拒绝，不 fallback。

## 声明与独立批准

目标可声明 `sdk_provider_factory`：

```ts
{
  provider_id: "example",
  package_manifest: captureEntrypointDescriptorV1("/actual/package/package.json"),
  module: captureEntrypointDescriptorV1("/actual/package/src/child-factory.ts"),
  export: "createChildFactory",
  config: {},
  artifacts: [captureEntrypointDescriptorV1("/actual/package/src/delegate.ts")],
  observer: { // 可选
    module: captureEntrypointDescriptorV1("/approved/observer.ts"),
    export: "installActivityBridge",
    input_channel: "example:activity"
  }
}
```

target 只声明这一个 provider，不带 tools/commands/dependencies。manifest 必须是 factory 和 child entrypoint 最近的实际 package.json。descriptor 固定 canonical 当前 UID 常规文件、身份和 SHA256；canonical 路径被软链替换则 live identity 校验拒绝。artifacts 列出已知 delegate/assets，不是 JavaScript 传递依赖沙箱。

config 为封闭有界 JSON 对象：12 层、2048 节点、32 KiB，字符串最多 8192 UTF-16 单元。

管理员独立审阅并写实际 `<agent-dir>/sdk-provider-grants.json`：

```ts
{
  version: 1,
  grants: [sdkProviderApprovalV1(manifest, "pi-subagents")]
}
```

sdkProviderApprovalV1 返回 `{owner_id,target_id,manifest}`，只含一个 target。grant 精确批准 owner、真实 Main descriptor、child、package、factory/export/config/artifacts 和可选 observer。两份自报 hash 相同不够，发现与执行都检查真实文件。grant 文件本身须非软链、当前 UID 常规文件，按 inode/size/mtime/ctime 缓存，未变不重解析。没有运行时写 grant API，缺 grant 不执行外部 factory。

选择已声明 SDK factory 的 provider 创建 Subagents 或 Side 时，准入在模型过滤前检查该 target 的独立批准。缺匹配批准、文件不存在、文件损坏/不可读取均以中文明确报「SDK provider 未授权」，包含 provider、owner、target 和实际 `<agent-dir>/sdk-provider-grants.json` 审阅批准路径；无匹配批准保留 `no exact grant` 诊断标记。同一 provider id 的多个 owner 中，任一声明获批即可通过该检查；全部未批准时错误列出所有未批准 owner。执行仍只从已批准集合选唯一 owner，多个已批准 owner 仍以歧义拒绝，未批准声明不参与执行。错误不回退其他模型，factory 的模块顶层也不执行。执行前和 await 后的撤销/漂移复查仍生效。其他 provider 的未批准声明或坏 grant 不阻断所选内置模型；provider 根本没有该 target 的 SDK factory 声明时，仍按消费者原有的不支持策略处理。

## 冻结与装配

冻结 entry 携带 `sdk_provider:{version:1,owner_id,target_id,manifest,model_scope}`，完整 proof 进入指纹。Main/role/frozen/parent model scope 仍是模型权限唯一来源；proof 绑定本次精确 scope。嵌套只能缩窄，新增声明/grant 不给旧 frozen role 增 provider。无 proof 的旧 profile 可看历史，不能执行。

装配精确传入 `{version:1,target:"pi-subagents",agentDir,providerId,modelIds,config}`，config 嵌套，不能覆盖核心字段。export 必须返回 Pi extension factory；发现阶段不 import。执行在 await 前后重验 grant、文件、冻结 scope、live binding，再用 `getSessionAssemblyPublicModules()` 原表加载批准模块。

已加载同路径代码/已知 delegate 的 digest 变化，即使重新批准也须新进程。公开 provider 引用只 fence 准备期间的替换，不是宿主认证来源。registry/grant/disposal 都是同进程合作合同，不隔离恶意 JS，不新增 host private seam、owner receipt 或沙箱。

## observer 与目标隔离

observer 使用相同批准 loader/grant，只收到窄 bus：on 只允许 input_channel，emit 只允许该 provider 经校验的 `provider:activity-v1`，不收到 ExtensionAPI。启动失败、execution dispose/reload 释放 listener；普通 view detach 不释放。缺 observer 则无专用活动翻译。

其他 target（如 pi-side-chat）须独立声明/grant，Subagents grant 不暗示支持它。root closure 只选明确批准的 SDK proof；builtin、Timeout、Processes、Search 的 tool owner guard 独立。Search factory 接收真实父 Main event bus，用于显式后端发现。
