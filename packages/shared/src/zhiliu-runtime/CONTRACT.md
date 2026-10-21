# 可信 CLI 启动合同

`zhiliuManagedRuntimeProfileSchema` 校验 Host stdin 首行。只有本机 capability，无平台登录凭据或上游信息。原 V4 业务 RPC 不能改变该 profile。协议、限制来自平台，工具未限制时保留桌面原能力；云端必须显式提供空工具与空插件根。参见 `specs/zhiliu-managed-runtime.md`。

platformTools 是可选可信 `/mcp` 本机工具桥，capability 必须与模型 capability 不同；server 固定为 zhiliu_platform。工具凭证由 closure transport 注入，不进入 MCP 配置。工具身份元数据只供幂等，服务端仍用授权 Run/lease epoch 校验权限。活跃进程 await 不承诺跨进程冷恢复。

`approvalRequiredTools` 是 Host 为平台写操作施加的单次同意约束，只准 `mcp__zhiliu_platform__*`，不能重复，最多 500 项；显式 `toolAllowlist` 时必须为其子集，省略清单仍按既有语义保留原生及插件全部能力。可用工具不等于已同意写入：这些工具复用原生 permission request、`user-once` UI，应答前不执行，不允许 Hook、yolo、allowedTools、项目或会话 allow 绕过，不允许响应持久化授权。Plan 与显式 deny 保持阻断。云端不传此字段时维持既有工具语义。服务端仍负责授权、幂等和写入的最终校验。
