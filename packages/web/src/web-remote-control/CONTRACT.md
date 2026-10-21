# web-remote-control

手机远控 admission、设备列表、transport 与只读页面。

入口通过 auth/HTTP/location/storage 端口操作外部状态；契约的设备分组与缓存展示类型不依赖实现。entry 的 AbortSignal 控制本次导航；transport 的 socket/generation 控制连接。只提取帧解析与独立请求关联，不创建第二份恢复 owner。Main/Host/CLI 继续拥有业务状态，手机仍为 replayable。

bootstrap 请求只读取响应。version guard 校验当前请求代际与版本后，同步通过 `onAccepted` 提交查看 epoch 等接受副作用；失效、释放或版本不匹配的回包不得产生该副作用。

织流网页登录使用可选异步 `prepareSession` 和凭据变化订阅端口。HTTP adapter 沿用 SaaS 同源 sessionStorage Bearer 边界换取短期 terminal rc_ 并独占其内存；同 scope 刷新只让原 transport 重连，身份 scope 改变撤销 Entry 并重新 admission。legacy `getZCodeJwtToken` 在此返回 rc_，不读取官方 OAuth、本地 Key，不持久化 rc_。Root/Host/CLI 仍是唯一任务所有者。具体刷新/失败/取消顺序见 `specs/zhiliu-relay.md`。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。
