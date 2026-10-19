# 织流桌面二开：平台授权接入技术版

源码基线：ZCode `6d5982eb94c8f12a6a8c8b778da1a9f447208a5a`，产品分支 `zhiliu/desktop-saas-20261019`。
保留 `origin` 上游和 `fork` 产品仓库，保留 Apache-2.0 及第三方声明。本分支没有修改织流 SaaS 的原始需求文档。

## 已实现

- 明确的「云 Agent / 本地项目」入口；用户只登录织流，模型与上游 Key 由平台统一管理。
- 云工作台复用现有 SaaS 网页、登录和空间权限，云调用仍走既有积分计费链。
- 远端页面使用独立窗口和按服务 origin 隔离的浏览器 partition，无 Node/preload/本机 RPC；系统权限、跨源导航和弹窗默认拒绝，下载由用户选择位置。
- 本地项目保留现有窗口与 Host 分层、文件/Git 和应用内记录界面；本批不启动 bundled CLI。依赖 CLI 的推理、工具、Skill/MCP 与自动化尚未开放。
- 独立应用 ID `ai.zhiliu.desktop`、Electron profile 和 `~/.zhiliu-desktop` 数据根，启动设置、存储扫描/清理与全局 CLI 配置探测一并隔离。
- 关闭上游账号、套餐、奖励、分享、官方手机 relay、反馈工单和自动更新；保留本地日志。关闭个人模型/Key/端点设置、供应商导入及连接探测，服务端拒绝个人配置和本地模型执行旁路。
- 客户端「问题反馈」打开织流自己的普通反馈页，与网页共用后台和空间权限；用户预览、确认后提交，可查看处理状态。上游反馈工单继续关闭。
- 接入[织流独立自动更新](auto-updates.md)，复用原有更新状态机。未配置自有 HTTPS 来源时明确提示未配置，不回退上游；当前技术包尚未启用真实下载和安装升级。
- 关闭上游遥测初始化/页面注入；保留不上传的本地 crash dump。未初始化 SDK 不得阻断首窗。
- 织流构建不注册上游 `zcode:` 和 Explorer/Finder 集成，不覆盖同机 ZCode。
- 修复 Windows autocrlf 对固定 Gen UI 资源字节和摘要校验的影响，保留完整校验。

## 当前限制与下一批

这批交付云工作台入口和本地项目壳，不是四端协同产品的完整交付。安装包、安装位置和安装后验证以该批发布记录为准；构建脚本或开发态 smoke 成功不等于安装包验收完成。

1. 本地模型推理关闭，不接受用户自有模型 Key，平台管理员 Key 不下发。云窗口可登录 SaaS 并使用既有积分链；下一批完成任务级累计计费网关、短期设备授权、限额与退款关联后，再开放本地 Agent。不能把云窗口已登录视为本地已获得模型授权。
2. Web 查看本地历史、向桌面派发任务和跨端追加指令尚未接通。后续需织流鉴权 broker + 现有 Host adapter，同一 CLI/runtime 拥有 admission/取消/审批；不能把 ToolRequest 当终端命令来承载聊天任务。
3. 设备授权、本地历史显式共享、离线补偿、远程审批及撤权待验收。当前云窗口没有本地设备工具桥。
4. 开源 Computer Use producer 为占位实现；不能宣称已有完整电脑控制或操作系统沙箱。
5. 云登录使用 SaaS 当前 sessionStorage，关闭窗口后需要重新登录；本版不复制登录 Token 到本地 Host。
6. 应用图标、启动标识、菜单及窗口品牌已统一为织流，保留第三方供应商图标与开源署名。工作台布局沿用上游结构；平台首次使用引导和无障碍细节后续迭代。
7. 当前构建和安装验证目标是 Windows x64，macOS/Linux 尚未做整包验收；远端 SSH/WSL/Docker 所需跨平台运行时不在本轮包中验证。
8. 云端录音/屏幕共享等浏览器系统权限当前关闭；附件上传不受这一限制。

## 构建

使用仓库固定的 Node 24.14.0、pnpm 10.33.2。安装依赖后运行：

```powershell
$env:ZHILIU_CLOUD_URL = 'https://your-platform.example'
$env:ZCODE_SKIP_REMOTE_ASSETS = '1'
pnpm build:zhiliu-desktop -- --os win --arch x64
```

仅本机开发可使用 loopback HTTP，通过安全隧道连接服务器。不要将运维私钥、密码、上游 Key 打入客户端。
本机测试安装包使用 `http://127.0.0.1:18780`，需要独立安全隧道；分发给客户前必须用正式 HTTPS 服务地址重建。
`ZHILIU_CLOUD_URL` 可由可信本机启动环境覆盖；不接受云网页提供任意服务地址。
成功打包后的预期产物为 `packages/desktop/dist/织流-3.15.1-win-x64.exe`；独立 appId 用于与 ZCode 并存，仍需对该产物实际安装验收。

## 验证入口

```powershell
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm exec vitest run test/zhiliu
node packages/desktop/scripts/zhiliu-cloud-window-smoke.mjs
node packages/desktop/scripts/zhiliu-desktop-edition-smoke.mjs
```

整包 smoke 使用临时 profile/home 和本地 fixture，真正启动 Main/Host/Renderer，验证首次云入口、窗口命令、无本机桥、草稿保留、关闭云窗后本地窗口存活；不会证明 bundled CLI、本地推理或工具可用，不把 fixture 当真实云端对话验证。
Windows 发布包关闭 Main Inspector，不能使用 Playwright Electron launch 验收安装包。安装后的实际程序使用页面 CDP 测试，保留发布 fuse：

```powershell
$env:ZHILIU_SMOKE_EXECUTABLE = 'C:\path\to\织流.exe'
# 不设置 ZHILIU_CLOUD_URL 时使用本机 fixture；设置可信服务 URL 时只检查真实登录页和 readiness。
node packages/desktop/scripts/zhiliu-installed-smoke.mjs
```

该测试只为自己启动的进程创建临时 profile、loopback 调试端口，结束后关闭该进程树；不修改安装包、不接管用户窗口。设置 `ZHILIU_SMOKE_SCREENSHOT` 可保存截图。真实服务验收不自动登录、不创建账号、不发起付费请求。

仓库标准 `pnpm typecheck` 通过。额外尝试 desktop 全部 tsconfig 时发现原有 main/renderer 的 rootDir、Window bridge 声明等错误；该补充检查不宣称通过，详见本机验收记录。

初版安装产物与验收：[2026-10-19 平台授权桌面技术版](releases/2026-10-19-managed-preview.md)。后续品牌、反馈与更新验收以对应批次发布记录为准。

关联设计：[产品边界](../../specs/zhiliu-desktop-edition.md)、[官方服务隔离](official-cloud-isolation.md)。
