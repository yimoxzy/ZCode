# 2026-10-19：织流品牌、反馈与更新接入

本批统一织流客户端品牌，将桌面反馈接入织流 SaaS，并接入自有更新策略。上游固定基线仍为 `6d5982eb94c8f12a6a8c8b778da1a9f447208a5a`，保留上游仓库、Apache-2.0 与第三方署名。

## 安装产物

- 应用代码提交：`83fe2567`，品牌提交：`05bad492`；分支 `zhiliu/desktop-saas-20261019`。
- Windows x64 安装包：`F:/agent/zhiliu-artifacts/2026-10-19-branding-feedback/织流-3.15.1-win-x64.exe`。
- 版本 `3.15.1`，大小 `153435573` bytes，SHA256 `3CDD7DC5A28684DD8477A8333124F8EA59AA80ECADFB2D60247FF6089EF94719`。
- 已实际安装到 `%LOCALAPPDATA%/Programs/Zhiliu-SaaS-3.15.1/织流.exe`，安装器退出码0；桌面和开始菜单快捷方式为「织流 SaaS」。
- 应用 ID 仍为 `ai.zhiliu.desktop`；仅发布包 metadata.name 改为 `zhiliu-desktop`，使更新缓存独立。既有同 appId 安装复用注册表安装位置；未显式指定路径的新装默认目录由该 metadata.name 派生。

此包未签名，使用本机安全隧道访问开发服务，适合本机开发验收。客户分发需要正式 HTTPS 云地址重建及签名；运维私钥、密码与上游 Key 未打入安装包。旧技术包的独立备份和旧发布记录保留，不以本批摘要替换旧包摘要。

## 已完成

- 安装器、卸载器、系统图标、托盘、窗口、HTML 首帧、欢迎与空态、资源管理、应用菜单、中英文自述使用织流现有品牌。第三方工具图标与开源署名保留。
- 桌面工作模式栏、帮助与标题菜单的问题反馈进入固定同源 `#/feedback?source=desktop&app_version=3.15.1`；复用已有云窗口，不复制登录 Token 或建立本机工具桥。普通云入口继续只聚焦现有窗口。
- 网页与桌面反馈共用 SaaS 后台：普通描述、可选诊断预览、确认提交、防重复和本人处理状态。运行失败主动询问用户，只有用户确认才发送。账号/空间变化中止请求并隔离迟到响应；平台管理员统一处理，企业管理员不能跨用户读取反馈。
- [自有更新策略](../auto-updates.md)复用既有检查、下载、取消与安装状态机。固定构建期 HTTPS 来源、同源下载和重定向检查、SHA-512、Windows 固定签名发布者及独立缓存已接入。检查更新不由用户配置；上游更新来源继续关闭。

当前包没有配置真实更新源，点击检查显示未配置；默认不下载或安装。正式 HTTPS 发布服务、证书、签名安装包与真实跨版本升级验收尚未完成，不把接入框架当作正式自动升级验收。

## 验证证据

| 范围 | 结果 |
| --- | --- |
| 标准类型、Lint、架构检查 | 通过；Lint 0 errors / 62 既有 warnings；架构0违规 |
| 织流专项与既有更新/菜单回归 | 集成批25文件171项通过；自有更新专项7文件117项通过；最后菜单边界3文件26项通过，存在重叠，不累加 |
| 打包 | 成功，运行时依赖闭包及资源校验通过，安装包约146.3 MiB |
| 实际安装 fixture | 8项通过，含反馈 hash 导航、草稿保留及无本机桥 |
| 实际安装真实 SaaS | 9项通过，含真实登录页、反馈需登录、API/Worker ready；schema `024_general_feedback` |
| 原生品牌 | 安装/卸载/应用/托盘图标提取并实查，资源摘要与品牌源一致；快捷方式指向已安装织流程序 |

补充仓库级发布回归：1092文件中1089通过，12201用例中12172通过、25跳过、4失败。失败分布为3条文件URL用例和1条上游套餐Provider源码断言：前者把无盘符POSIX路径用于Windows，并错误地把合法Windows UNC当作非法URL；后者仍要求没有属性的旧Provider标签。仅修正测试fixture和显式品牌边界断言，保留精确路径、锚点剥离、非法URL拒绝、UNC平台语义及官方套餐禁用验证。修正后原生两文件19项、UI与既有隔离专项两文件11项通过，标准typecheck/Lint/架构检查通过；没有修改业务代码或重新替换已验收安装包。不把首轮完整回归写成全通过。

真实服务检查未注册用户、未登录用户账号、未调用模型或消耗积分。安装 smoke 使用自己的临时 profile 和 loopback CDP，保留发布包关闭 Main Inspector 的设置，结束仅清理自身进程。

本机日志在 `F:/agent/zhiliu-toolchain/`：`zhiliu-brand-final-package.log`、`feedback-final-typecheck.log`、`feedback-final-lint.log`、`feedback-final-architecture.log`、`feedback-final-unit.log`、`feedback-final-menu-tests.log`、`feedback-installed-fixture.log`、`feedback-installed-live.log`。原生图标证据为 `zhiliu-native-brand-evidence.json` 和 `zhiliu-native-brand-sheet.png`。

## 云服务部署与边界

对应 SaaS 应用代码为 `1e95cd5`。服务先备份，再增量部署15个源文件与23个静态文件，不重置服务器已有工作树。增量快照为 `backups/feedback-deploy-20261019T050002Z`，完整数据备份为 `backups/20261019T050003Z-03abcf6c92fd`，均留在服务器受保护目录。迁移至024后检查73张表与定义一致，服务和 Worker ready。

原始需求文档 SHA256 保持 `80159201ece2a2132fb8afec2f421126ed8597104dcd5c24aeed427d27f81281`。024为增量迁移；存在一般反馈时禁止有损降级。回退应用应保留024兼容模型和迁移，不自动降级或丢弃反馈。

本地 OAuth/短期设备授权及模型计费网关仍未接入，所以本地推理、CLI、Skill/MCP 和电脑自动操作继续关闭；Web与本地历史互通、跨端任务、完整 Computer Use 仍待交付。此批不改变已有托管模型和租户隔离边界。
