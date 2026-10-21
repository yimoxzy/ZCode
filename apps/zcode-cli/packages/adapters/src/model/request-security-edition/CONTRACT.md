# cli-managed-request-security

可信 Bootstrap 注入 Profile 后，模型最终 HTTP 边界只接受该本机 broker 的固定 POST 路径和平台虚拟模型。
capability 留在闭包中，替换任何 SDK 或环境传入的身份字段；用户配置代理和 endpoint routing 不参与托管模型流量。
禁止重定向与有状态 Responses，强制 store=false，保留请求级幂等身份和取消信号。
未注入 Profile 时保留开源上游 transport。服务端路由、计费、额度和 tenant 授权归 SaaS gateway。
本模块不提供操作系统沙箱，也不替代本地工具审批。

跨模块验收见 bootstrap/tests/managed-runtime.test.ts；真实网络及工具 Loop 验收见 cli/tests/managed-runtime.integration.node-test.ts。
