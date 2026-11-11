# child-capabilities-v1

## 责任与信任

`pi-runtime-contracts/child-capabilities-v1` 定义 Main 插件的声明、注册、session binding、发现与能力闭包，以及普通 child factory 的文件证明。`pi-session-runtime/child-factory` 使用同一份证明装配 SDK extension；Subagents 与 Side Chat 共用这个 loader，不维护插件审计名单。

**已加载即信任**：提供方在自己的 Main extension 中注册，并在真实 `session_start` 绑定当前 session；只有该 session 的有效 binding 才进入 snapshot。注册但未绑定、已释放、已被替代的 owner 不会被发现。实现会验证 Main/child 文件归属同一个实际包，以及包名、文件身份与 SHA；它不能认证调用注册/绑定 API 的 JavaScript 是否来自该包，也不能独立证明该包已经被宿主加载。提供方须遵守不代注册、代绑未加载插件的协作约定。registry 是可信同进程代码的协作合同，不是调用方身份认证或 OS 沙箱。

开放的是 factory 的装载，不是工具/provider 执行授权。Main active tools、role 工具投影、工具定义指纹、required capability 与原有 closure 仍决定 child 权限；声明没有授予 active tools 的旁路。factory 的工具、命令声明仍经过冲突、依赖与闭包检查。外部 `sdk_provider_factory` 仍走独立 target、grant、模型 scope 与生命周期验证，完整合同见 [SDK provider](../../pi-subagents/docs/sdk-providers.md)；普通 factory 不能注册 provider，也不复用或扩散 provider grant。

## 声明与冻结

现有 manifest/target DTO 保持 V1；target 增加可选 `child_factory`。提供方用 `captureChildFactoryV1(mainEntrypoint, declaration)` 构造它：

```ts
const main = captureEntrypointDescriptorV1(actualMainEntrypoint);
const child = captureEntrypointDescriptorV1(actualChildEntrypoint);
const target = {
  child_entrypoint: child,
  child_factory: captureChildFactoryV1(main.canonical_path, {
    module: "src/child.ts",             // 相对于声明方包目录
    export: "createChildFactory",       // 具名函数 export
    artifacts: ["src/execution.ts"],    // 可选：实际执行文件/已知 delegates
    kind: "execution",                 // 默认 execution；或 presentation
    // package_name 可省略；若填写，必须等于实际 package.json name
  }),
  activation: "mirror",
  commands: [], tools: [], providers: [],
  hooks: ["request/example-v1"], requires: [],
};
const registration = registry.register({ version: 1, manifest: {
  version: 1, owner_id: "example-owner", main_entrypoint: main,
  targets: { "consumer-target": target },
} });
```

`owner_id` 是协议 namespace；实际 npm 包身份由冻结的 `package_name`、`package_manifest` 证明，不从 owner 字符串猜包目录。`captureChildFactoryV1` 找 Main 文件最近的实际 `package.json`，读取真实 `name`，冻结 manifest 的文件 descriptor。返回字段为 `{kind,package_name,package_manifest,module,export,artifacts,files}`；`files` 按 `[module,...artifacts]` 顺序存 descriptor。

`child_entrypoint` 也必须在声明方的同一个包内；module/artifacts 必须是包内相对路径；absolute、越界、软链逃逸、落入另一个嵌套包都拒绝。文件必须为当前 UID 的 regular file；descriptor 固定 canonical path、device/inode/size/mtime 与 SHA-256。注册时重验真实包名及全部文件，不能用自报 SHA 给未校验的执行文件背书。已知实际执行文件应列入 artifacts；这不是 JavaScript 传递依赖沙箱。

`activation: "mirror"` 的 factory 随有效 Main binding 进入 closure；`required-only` 仍只在工具、provider、命令或显式 required/dependency 需要它时进入。owner/工具来源冲突、重复 child entrypoint、缺 dependency、依赖环或绑定顺序错误沿用 closure 的拒绝语义，不靠加载顺序选择赢家。

工具来源路径由共享 `sourcePath({path,baseDir?})` 规范化：绝对路径直接 realpath，相对路径须提供 baseDir；缺 base 或文件不可解析时由消费者诊断，不用未规范化路径猜 owner。

## 创建时状态与 factory 参数

binding 可提供同步 `capture_context: () => JSON对象`。snapshot 调用它并深拷贝、冻结结果到该 registration 的 `factory_context`；回调失败会给出 owner 诊断并留下空 context，不影响其他 owner。context 限 32 KiB，不能携带函数、凭据或父 session 的可写 handle。

消费者创建 child 时保存 `ChildFactoryProofV1={version:1,manifest,target_id,context}`。Subagents 将它及 `factory_required` 放入 frozen capability entry 和指纹；Side 在创建 plan 时捕获。后续请求、view detach/rebind、resume 不重新取父会话的可变 context；nested child 只能继承直接父 child 的 frozen proof context，不读取 Main 后来变化的 context；声明也只能继承父已冻结的范围，不能从 ambient 新增 owner 扩权。旧 profile 没有新证明时仍可读历史，不自动补证明执行旧工具。

具名 export 接收消费者明确提供的 options，并返回 Pi `ExtensionFactory`：

- execution：`{target,agentDir,sessionScopeId,context,getBridge?,backendEvents?}`；`target` 为 `subagent` 或 `side-chat`。bridge、父 event bus 只由实际消费者显式传入，不从插件名发现。
- presentation：`{target,taskName,returnLabel,readOnlyStatusline,viewLifecycle,context}`。分类不限制包名、文件后缀或 export 名；必须没有 tools/providers/commands，不含 SDK provider factory。缺席或可选装载失败时回到原生 Pi 展示。
- 声明 `execution/cancel-pending-v1` 的 factory 必须返回带 `cancelPending(): Promise<void>` 的 extension function；消费者在原有撤权/销毁边界等待其 durable cancellation。`execution/process-wait-v2` 声明其 lease owner 参与现有 Process wait bridge；消费者从 closure 取得 owner，不写死包名。

这些参数不覆盖 config 或模型权限；factory 不能通过注册命令/provider 来扩大声明。普通 factory 注册的工具必须在 target.tools 中，命令必须在 target.commands 中。它们是否 active/可执行仍由消费者原有的投影和 fence 决定。

## 装载、重验与失败

证明在注册、共享 loader 的 import 前、await 后及 extension 安装前四处重验，包括 Main/child 文件、实际包名、factory/export 声明和全部 artifacts。经 canonical SDK namespace 表加载具名 export；同路径代码或已知 delegate 的摘要漂移即使重新注册，也不能给旧模块 cache 背书，须启动新进程。JSON object key 顺序不影响证明。

单个可选 factory 的文件/包名漂移、import/export/返回值或安装失败，只跳过该 owner 并给出诊断；其余 factory 继续装载。安装期间的工具、hook、command/renderer 等注册先暂存；工具 schema、命令 handler 和 flag default 在提交前验证，成功后提交，失败不留下半份注册。可选 hook 后续失败退役该 owner 的 hook，不中断其他 owner。

如果它提供 child 明确选择的工具、显式 required capability 或所需 dependency，失败仍拒绝这次 child 装配；不得退回宽松 builtin 或恢复已取消的权限。required 语义与 registry/closure 冲突语义不放宽。required owner 的取消端口失败保留原 cleanup ownership，不能谎报销毁成功；可选 owner 的端口异常只诊断该 owner。

## ABI 与验证

公开 manifest/register/bind/snapshot DTO 与函数名仍为 V1；全局存储是 ABI2（`pi.child-capability-registry.v2`），旧 ABI1 不读、不覆盖。编译消费者与提供方须使用当前共享库，重建后启动新进程。registry holder 的完整规则见 [registries](registries.md)。

Runtime Contracts 离线测试验证注册/binding、声明冻结、真实 SHA 漂移、越界/冒用身份和独立 owner；Session Runtime 离线 loader 测试验证未知 export、import/安装失败隔离与 canonical proof。跨插件 faux-provider 请求、缺失降级与双加载顺序由[根 integration](../../../integration/README.md)验证，不发真实请求。
