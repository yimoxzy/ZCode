# 织流原生辅助界面品牌

## 产品规则与边界

- `ZHILIU_DESKTOP_ENABLED` 为真时，原生 MCP 应用权限确认框、默认应用名称以及 Windows 电脑操作提示条显示「织流」。未开启时维持上游 ZCode 文案。
- 同一开关控制应用菜单、托盘菜单与 tooltip 的品牌展示，保留现有消息 ID。织流托盘不展示尚未接入的上游自动更新入口。
- 开发态托盘图标使用 `build/zhiliu/`；打包态仍按现有 `resources/icon.png`、`resources/tray_icon.ico` 资源契约加载，由构建流程提供织流图标。
- 本次只修改已有展示文案，不开启本地推理、MCP 或 Computer Use；提示条仅在已有调用方实际显示时生效。
- 沙箱协议、内部路径、服务名和诊断进程名称保持既有契约，不通过全面字符串替换改动。
- 第三方 MCP 提供的 `serverName` 保持原样；仅缺省名称使用当前产品品牌。

## 所有者与接口

- 权限规则模块 `pluginSandbox/permissions.ts` 统一拥有默认应用名称和确认框文案，Host 与权限结果记录复用同一常量。
- `windowsCuaOperationIndicatorContent.ts` 拥有提示条的本地化文案和尺寸；生命周期及权限判断不变。
- 构建身份仍由 `@zcode/shared` 的 `ZHILIU_DESKTOP_ENABLED` 提供，不新增运行时配置。
- `getDesktopMenuMessage` 是共享菜单文案出口；托盘复用它，不另建翻译表。

## 验收

- 织流构建的中英文权限说明、缺省应用名称和提示条无 ZCode 品牌；明确第三方名称不改。
- 上游构建中英文文案不变。
- 织流托盘显示织流品牌并隐藏检查更新；上游 production 构建仍展示检查更新。开发及打包态路径均维持跨平台兼容。
- 提示条 HTML 保留 CSP、状态语义和转义流程，尺寸能够容纳对应品牌。
- 原有权限裁决、同意记录、取消与生命周期不变。
