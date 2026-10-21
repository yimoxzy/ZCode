# desktop-web-remote-relay

将 Main 的 HTTP、存储和 device WebSocket 与 manager 装配隔离。

仅 index.ts/contract.ts 供外部消费。manager 仍唯一拥有 window runtime 与 attachment；transport 唯一拥有 socket/generation。storage 只保存非敏感身份，clearLegacy 合并并发且失败可重试。凭据从注入端口读取，HTTP 错误只返回分类。

恢复目录的 AppSettings context 只携带版本化 `{ version: 1, userId, endpointOrigin }` identity；无绑定旧记录可读但不能恢复。织流 login.userId 是已校验的 `user_id:space_id` principal，不是裸用户ID。manager 必须比较完整 identity 后才能启动，同账号普通重启可复用，signed-out 清除目录意图。Main 内仅排序 startup settings save/clear 的写屏障不能等待 registration queue，以免 getLogin 授权撤销时重入死锁；不得由 transport/UI 另存授权目录。

完整语义见 [Relay V2 spec](../../../../../docs/web-remote-control/relay-v2-pairing.md)。
