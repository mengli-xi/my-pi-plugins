# 本地化

## Optional SDK，不是插件硬依赖

没有 `@juicesharp/rpiv-i18n` SDK 时，本包完整可用，界面使用 inline English fallback；不警告、不崩溃。SDK 存在时，本包注册自己的 locale 文本，并在渲染时读取共享 locale。它不是要求另一个 extension 必须先加载的协作。

开发依赖装配可以包含 SDK，用来检查 locale；这不等于默认启用 i18n extension，也不能为了 Ask 依赖某个语言 UI 插件。本包不注册 `/languages` 或 `--locale`。需要语言选择 UI 的用户可以自行启用 i18n 提供方；没有它时仍使用 SDK 的公开 locale 解析能力。

## 语言来源

共享 locale 的解析、持久化和环境优先级由 i18n SDK 定义，本包不另存配置、不读其他插件的私有文件。SDK 支持命令行 locale、官方 locale 配置与 `LANG`/`LC_ALL`，最后回退 English；不要把这些文件移入 Pi 的目录。

界面在 render 时取字符串，支持共享 locale 更新；缺少单个翻译键时使用调用点的英文 fallback。没有 SDK 时，环境语言不改变本包的英文界面。

## 随包语言

`locales/` 包含 `de`、`en`、`es`、`fr`、`pt`、`pt-BR`、`ru`、`uk`、`zh`。翻译范围包括自定义/Next 行、页脚、notes/global notes、Submit review、折叠提示、外部编辑器失败提示、RPC 提示和 context 标题。

模型所见 description、schema 描述、错误正文和保留 label 列表保持英文，不随界面语言改变。两个本地控制 label `Chat about this`、`Explain More` 也保留英文。验证始终比较 canonical English label，不能靠换 locale 绕过保留名。

## 增加翻译

复制 `locales/en.json` 到 SDK 支持的 locale 文件名，翻译值并保留全部 key、占位符与前导符号。`{key}` 代表用户实际配置的快捷键，不能写死为 `n` 或 `Ctrl+]`；其他占位符也不能删改。

loader 根据 SDK 支持的 locale 集合注册文件。新增语言后用新 Pi process 检查显示，再检查 SDK 缺失和缺少单个 key 时都能回退。无需为单一 locale 建立新依赖、另一个配置存储或跨插件 import。
