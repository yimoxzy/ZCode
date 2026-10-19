# 织流安装包品牌

## 规则与所有者

`packages/desktop/electron-builder.config.js` 是安装包品牌资源映射的唯一所有者。仅当 `ZHILIU_DESKTOP=1` 时，应用、安装器、卸载器、托盘、Windows 任务栏、macOS 与 Linux 图标使用 `packages/desktop/build/zhiliu/` 下的织流资源。其余构建继续使用原上游资源，不覆盖原文件。

图标来源为已存在的织流 SaaS 项目 `desktop/assets/icon.svg`、`icon.png`、`icon.ico`、`icon.icns`；不重新设计标志。Linux 尺寸由原 1024px PNG 等比例缩放产生。资源来源与校验值记录在该目录 README。

织流构建保留 `resources/icon.png`、`icon_windows.png`、`tray_icon.ico`、Linux `icon_512x512.png` 这些运行时文件名，降低主进程的变更范围。开发态按主进程品牌规则选择 `build/zhiliu/`，不依赖安装包映射。

安装包的 `description`、`productName` 和 `author.name` 使用织流；主页使用已核实的项目 fork 地址。不将上游支持邮箱呈现为织流支持邮箱，不编造未确认的公司或联系方式。Linux maintainer 暂为“织流”，正式 Linux 发布前补充真实维护邮箱并完成整包验收。

macOS 织流 DMG 使用纯色背景，避免携带上游背景品牌。保留原上游 NSIS 安装逻辑、第三方声明和许可证；NSIS 用户可见文字由安装脚本规则单独控制。

## 验收

- Windows、macOS、Linux 构建配置均只引用织流品牌资产，资源真实存在、ICO/ICNS/PNG 格式正确，Linux 每个目录尺寸与 PNG 实际尺寸相同。
- Windows 安装、卸载和运行资源都源自同一织流标志；安装后的 exe 元信息、快捷方式、任务栏及托盘需在真实 Windows 安装包验收中检查。
- `ZHILIU_DESKTOP` 未开启时，原品牌资源、元信息及 DMG 背景保持原行为。
- 测试不代表 macOS/Linux 已完成构建、签名或正式发布验收；不能将通过配置校验描述为已发布。
