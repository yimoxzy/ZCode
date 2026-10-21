# 织流 Relay V2

兼容现有 ZCode Desktop/Remote frontend 的自有薄 relay。仓库不含上游生产 Go relay；此模块是织流实现，只转发原 V4 attachment 流，不执行模型或创建第二份任务。

从仓库根目录构建：`pnpm --filter @zhiliu/relay build`，产物 `packages/zhiliu-relay/dist/relay.cjs` 可独立在 Node 24 运行。

运行配置：

| 变量                         | 用途                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `ZHILIU_RELAY_HOST`          | 默认127.0.0.1，容器内设0.0.0.0                               |
| `ZHILIU_RELAY_PORT`          | 默认8091                                                     |
| `ZHILIU_RELAY_PUBLIC_ORIGIN` | 与织流网页相同的HTTPS origin                                 |
| `ZHILIU_RELAY_AUTH_URL`      | 固定内部API `/api/internal/desktop-relay/introspect` 完整URL |
| `ZHILIU_RELAY_SERVICE_TOKEN` | 与API `DESKTOP_RELAY_SERVICE_TOKEN` 相同的独立service secret |

反向代理把 `/api/v1/remote/` 路由到本服务，WS upgrade和read timeout必须支持长连接。访问日志应隐藏 `ws2` 查询参数。`/healthz` 为进程健康检查。仅部署一个副本；设备目录、单次token和socket owner暂在内存，重启由客户端按原协议重注册。多副本部署前必须实现共享owner/token存储。

Desktop rc*和Web terminal rc*由SaaS签发并绑定user+space，设备ID绑定native登录授权。每5秒内省根授权，撤销/到期关闭连接；重连沿用原Host任务和replay，不重开Agent。

验证：`pnpm exec vitest run packages/zhiliu-relay/src/contract.test.ts packages/zhiliu-relay/test/relay.test.ts`；类型检查 `pnpm --filter @zhiliu/relay typecheck`。Host与真实Web的完整任务E2E需另外执行，不能用relay echo替代。
