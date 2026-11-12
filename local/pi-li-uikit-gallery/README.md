# pi-li-uikit-gallery

## 用途

[`pi-li-uikit`](../pi-li-uikit/README.md) 的交互式组件展示，**仅开发用**，不需要随日常插件启用。共享库本身不注册命令或扩展生命周期；本包是独立 Pi 插件。

## 加载与命令

Pi 版本见[根支持说明](../../README.md#支持说明)；按[根安装说明](../../README.md#安装与加载)安装依赖后直接加载 TypeScript，无 build/dist：

```sh
pi -e "$PWD/local/pi-li-uikit-gallery"
```

`/uikit` 在 editor slot 打开组件目录。方向键选择，Enter 打开真实组件示例；Escape 返回目录，在目录按 Escape 关闭。没有交互式 UI 时提示不可用，不创建面板。本包没有配置文件。

目录包含九项：`TextPanel`、`EditorPanel`、`SearchSelect`、`TabStrip`、`LevelSlider`、`MultiSelectTable`、`ProcessPanel`、`CollapsibleBlock`、`SelectableCollapsiblePanel`。表格行激活演示 `MultiSelectTable > row` 形式的详情标题；进程面板使用示例数据，不启动真实进程。

`TabStrip` 和 `CollapsibleBlock` 是嵌入式基础组件，而非完整 editor-slot 面板。展示宿主使用共享面板风格：accent 标题分隔线、内容前空行、两列正文缩进、普通正文色，以及随宽度调整的 muted 底部提示。

## 依赖与可选协作

仅硬依赖共享库 `pi-li-uikit`，版本 `^0.1.0` 由根 workspace 解析。没有插件硬依赖；不加载 CC Style 也能展示组件。面板的布局与鼠标行为遵循 [UIKit 合同](../pi-li-uikit/README.md)，缺少可选布局能力时使用原生降级。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-li-uikit-gallery
npm run test -w pi-li-uikit-gallery
```

离线测试挂载真实组件，覆盖九项目录、逐项进入/返回、共享面板边框、表格详情、鼠标路由和清理；不操作用户终端或剪贴板，不证明人工交互与完整 profile。
