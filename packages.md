# Package 迁移登记

本页先登记本轮新增的 host 边界，不是完整 package/profile 清单。其余 package 仍逐包审阅、确认和迁移。

| 组件 | 职责与装配要求 |
| --- | --- |
| [Pi 1.5.0 host patch](host-patches/pi/v1.5.0/README.md) | 固定官方源码，维护显式主题监听补丁；CLI 与 canonical SDK 必须使用同次构建的完整 peer graph，不自动安装或部署。 |
| [pi-session-runtime](local/pi-session-runtime/README.md) | source-only shared library，无 extension registration/独立 build。仅 managed UI handoff 要求双面 `pi.theme-watch.file-version.v1`；缺失/未知拒绝交接，tool-only/headless 不受影响。改库后重建直接 compiled consumer，并启动 fresh Pi process。 |

能力 owner、consumer 与验证边界见 [`docs/pi/dependencies.json`](docs/pi/dependencies.json)。本登记不代表未迁 consumer 或完整发行 profile 已通过验收。

跨插件测试入口见 [integration](integration/README.md)；包内测试与特殊宿主的划分遵守 [CONTRIBUTING](CONTRIBUTING.md)。
