# web-remote-control

手机远控 admission、设备列表、transport 与只读页面。

入口通过 auth/HTTP/location/storage 端口操作外部状态；契约的设备分组与缓存展示类型不依赖实现。entry 的 AbortSignal 控制本次导航；transport 的 socket/generation 控制连接。只提取帧解析与独立请求关联，不创建第二份恢复 owner。Main/Host/CLI 继续拥有业务状态，手机仍为 replayable。

bootstrap 请求只读取响应。version guard 校验当前请求代际与版本后，同步通过 `onAccepted` 提交查看 epoch 等接受副作用；失效、释放或版本不匹配的回包不得产生该副作用。

织流网页登录使用可选异步 `prepareSession` 和凭据变化订阅端口。HTTP adapter 沿用 SaaS 同源 sessionStorage Bearer 边界换取短期 terminal rc* 并独占其内存；同 scope 刷新只让原 transport 重连，身份 scope 改变撤销 Entry 并重新 admission。legacy `getZCodeJwtToken` 在此返回 rc*，不读取官方 OAuth、本地 Key，不持久化 rc\_。Root/Host/CLI 仍是唯一任务所有者。具体刷新/失败/取消顺序见 `specs/zhiliu-relay.md`。

可选 `listRegisteredDevices(signal)` 仅返回当前身份下的设备登记展示信息（id/name/platform），由织流 auth adapter 读取原 SaaS 目录并检查 rootToken/完整 principal；没有该端口的上游构建不请求 SaaS。Entry 等待同一导航中的登记和 relay 结果后合并，不新增 presence、持久缓存或连接身份。登记行只有真实 relay 在线 SID 才可选择，无连接时沿用禁用行并标识“已登记，远控未连接”。SaaS online/workspace_ready 不参与在线判断；账号切换、取消或响应迟到均不得复活旧投影。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。
