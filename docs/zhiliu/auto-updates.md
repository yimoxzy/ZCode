# 织流桌面自动更新

当前已接入织流独立更新来源和原有更新状态机。未配置自有来源时不检查、不下载、不安装，也不会回退 ZCode 服务。当前本地技术包保持这个默认状态。

## 发布配置

以下变量只由可信构建环境设置，不是客户设置项；安装后修改系统环境变量或 ZCode Endpoint 不能改变内嵌来源。

| 构建变量                        | 缺省         | 作用                                                         |
| ------------------------------- | ------------ | ------------------------------------------------------------ |
| `ZHILIU_UPDATE_MANIFEST_URL`    | 空，关闭更新 | 自有 HTTPS YAML manifest 地址，不带查询参数、凭据或 fragment |
| `ZHILIU_UPDATE_INSTALL_ENABLED` | `0`          | `1` / `true` / `yes` 开放下载安装；缺省只检查                |
| `ZHILIU_UPDATE_PUBLISHER_NAME`  | 空           | Windows 安装更新时必须固定的 Authenticode 证书发布者名称     |

示例采用虚构域名，不代表已部署的更新服务：

```powershell
$env:ZHILIU_CLOUD_URL = 'https://saas.example.com'
$env:ZHILIU_UPDATE_MANIFEST_URL = 'https://updates.example.com/releases/manifest'
$env:ZHILIU_UPDATE_INSTALL_ENABLED = '0'
pnpm build:zhiliu-desktop -- --os win --arch x64
```

检查模式可以验证清单、版本提示和错误显示，下载/安装指令与旧自动下载偏好都不能绕过。正式开放前改为 `1` 并完成对应平台签名及安装验收。`ZCODE_AUTO_UPDATE` 保持关闭；织流仅由自有配置决定装配，`ZCODE_UPDATE_FEED_URL`、旧命令行 feed 参数和官方运行时 Endpoint 不参与来源选择。

## 服务端清单契约

客户端沿用已有自定义 `ManifestUpdateProvider`，不是直接访问 generic provider 的 `latest.yml`。请求示例：

```text
GET https://updates.example.com/releases/manifest?platform=windows-x86_64&device_mid=<own-device-id>&channel=1
Accept: application/x-yaml,text/yaml,text/plain,*/*
X-Platform: windows-x86_64
X-Release-Channel: 1
X-Device-Mid: <own-device-id>
```

`channel=1` 为 stable，`channel=3` 为 preview；平台使用现有 `windows-x86_64`、`darwin-aarch64` 等值。服务可以是按参数返回不同清单的接口，也可以先用固定 HTTPS 静态 YAML，忽略不需要的参数。不要在 URL 或清单中放账号 token、API Key 或临时签名参数。

```yaml
version: 3.15.2
files:
  - url: /releases/织流-3.15.2-win-x64.exe
    sha512: <安装包完整内容的 SHA-512，base64 编码，共 88 个字符>
    size: <安装包字节数>
releaseDate: "2026-10-19T00:00:00.000Z"
releaseNotes: |
  织流桌面版本变更说明
```

示例中的占位 SHA-512 必须替换后才能使用。每个文件，以及可选 `packages` 中的包都必须提供有效 SHA-512；相对路径按现有协议以清单来源的 `/` 为基准。下载文件、blockmap 和清单必须使用相同 HTTPS origin，不允许 query、fragment、凭据或跨源 CDN 地址；如需 CDN，使用同域反向代理。更新专用 Electron session 在首次请求和重定向时都会拒绝其他来源，因此不能以重定向绕过限制。

打包未配置来源时 `publish: null`，不生成默认上游更新配置；有来源时 `publish` 只指向自有域及相应发布者。generic 配置用于生成 `app-update.yml` 和安装器验证信息，运行时仍使用上述 manifest API。织流发布包的 metadata name 为 `zhiliu-desktop`，使实际缓存目录为 `zhiliu-desktop-updater`，与同机原 ZCode 分开；内部 workspace 包名不变。不存在“服务坏了就换回上游”的行为。

## 签名与正式发布条件

- Windows 正式包必须通过自己的签名流程生成，构建开启 `ZCODE_ENABLE_WINDOWS_SIGN=1`，并配置 `ZHILIU_UPDATE_PUBLISHER_NAME` 为实际证书发布者。继承的签名 hook 支持现有工具链；签名凭据由发布环境管理，不写入仓库。`publish.publisherName` 数组会写入 `app-update.yml`；运行时要求其与内嵌发布者完全一致。NSIS 下载后再由 electron-updater 验证 Authenticode，签名不匹配则拒绝安装。缺失 `publisherName` 时上游库会跳过此验证，因此织流增加安装前预检，不能只依赖库的默认行为。
- macOS 正式更新必须启用自己的 Developer ID 签名，使用原有 hardened runtime/entitlements 和独立公证流程；配置里 `notarize: false` 表示公证在独立发布步骤完成，不能理解为无需公证。Squirrel 的真实 staging/安装仍需在签名应用上验证。
- SHA-512 是完整性检查，不能替代代码签名。当前尚未完成自有签名安装更新验收；不要把检查模式、schema 测试或本地安装成功当成自动更新正式交付。
- 保持应用标识 `ai.zhiliu.desktop`、安装路径规则和用户数据目录稳定，使用递增 SemVer 的织流发布版本；不可将官方 ZCode 安装包填进织流清单。
- HTTPS 清单及完整安装包先上传并核验，再原子替换当前清单。保留至少上一版签名安装包及对应哈希；当前没有开发后台上传/发布管理器。

## 生命周期、失败与回滚

继续使用原状态机的检查去重、stable/preview 过期结果隔离、下载进度、取消、跳过版本及更新说明；轮询默认每 15 分钟，更新界面可见时每 2 分钟。`autoDownload` 与 `autoInstallOnAppQuit` 的库默认行为被关闭；正式模式是否自动下载由已有应用设置及 Main 状态机决定。Windows 仍等待用户确认重启，其他平台保持原有经过检查的安装生命周期。

退出安装前必须等待 Host/Agent 及 Windows 子进程退出、释放资源锁；准备失败不启动安装器。检查失败保留可见目标，下载失败回到可更新状态供重试，staging 失败清除失效 ready，不能凭旧更新说明伪装成已准备完成。

这不提供安装后的自动健康回滚。若新版本有问题，撤回错误清单，并将回退代码作为更高 SemVer 的签名修复版本发布；客户端禁止任意降级。无法启动时通过保留的签名安装包人工修复，先确认数据迁移兼容性并保留用户数据。后台业务发布与桌面安装更新分开操作。

## 验证要求

已有专项测试覆盖固定来源、非法配置、无上游请求、manifest/file 边界、重定向裁决、检查模式禁止下载/安装、Windows 发布者缺失/不匹配，以及真实 electron-builder schema 和 app-update 配置处理。原有 manifest 与更新状态机回归仍执行。

正式放行还需要自己的 HTTPS 服务和签名包，验证真实安装版从旧版本升级、弱网取消/重试、错误 SHA-512、错误签名、无来源、错误通道、资源占用、重启后版本及用户数据保留。测试必须在隔离安装和数据目录进行，当前技术包不自动执行这些安装操作。
