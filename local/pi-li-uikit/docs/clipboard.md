# UIKit OSC 52 行为与验证

本文说明现有 clipboard helper 的契约，不记录具体机器、profile、路径或旧性能数字，也不代表任何终端组合已完成真实验收。组件实现没有因本次文档校正而改变。

## 行为

- 使用异步 platform-command helper，系统复制先完成；不在 TUI thread 使用 `execSync`。
- SSH/MOSH 或 `PI_CLIPBOARD_OSC52 === "1"` 时，系统复制后再发送直接 OSC 52：`ESC ] 52 ; c ; base64 BEL`，没有 tmux DCS passthrough 包装。
- 变量未设置或为其他值时，不额外启用该路径；系统复制失败仍回退到一次 OSC 52。
- encoded payload 上限为 100,000 base64 字符，按 UTF-8 字节编码后的长度计算，不按原始字符数计算。恰好等于上限允许发送，超过则不发；系统复制成功仍算成功。
- clipboard helper 不上传模型内容，也不访问 provider。显式复制会把所选文本交给系统剪贴板或终端协议；终端是否允许写入、远程转发到哪个剪贴板，由实际终端设置决定。

## 自动化验证

从 package 目录运行：

```sh
npm ci # 在仓库根运行；以下验证命令在包目录运行
npm run typecheck
npm test
```

本库没有 `build` script 或 `dist/`。不能为验证添加伪 build step；需要 compiled output 的消费者由其自己的 build 负责。

clipboard 测试 mock 系统命令并捕获 stdout，覆盖未设置变量、`0`、`true`、`1`、中文多行、系统复制先于 OSC、恰好/超过长度上限和 fallback。它们不执行真实 clipboard command，也不向实际终端发送测试 OSC。

单测通过不等于桌面、SSH/MOSH、tmux 或移动终端的组合均可工作。不得把旧 checkout 的结果当成新版本或新终端的证明。

## 运行时生效

1. 在使用方实际 checkout 安装本库及其依赖，核对 workspace 链接和 public subpath 的解析位置。
2. 若消费者内联 UIKit，重建该消费者的完整产物；保留 bare-package import 的消费者仍须按自身构建约定验证。仅重启不保证 bundle 已更新。
3. 新开 Pi process，继承明确选择的 clipboard 环境；不使用 `/reload` 替代 rebuild/restart，不修改日常 profile 来凑测试。
4. 需要人工验收时，由操作者显式复制无敏感信息的短文本，再检查目标剪贴板。没有运行就记录 NOT_RUN。

本规范不要求安装服务、修改系统终端设置或操作任何不属于本次验证的会话。旧运维记录单独本地保全，不作为源码安装前提。
