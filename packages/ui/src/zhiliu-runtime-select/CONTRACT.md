# 织流桌面 Agent 与思考档位选择

该模块只投影 Main 返回的平台目录和当前项目选择。输入为现有 workspacePath、workspaceIdentity 与运行期 disabled；工作区身份优先，不自行维护账户、价格、任务、模型配置或长期选择真相。

通过既有 platform.executeDesktopCommand 的 getZhiliuRuntimeSelection/setZhiliuRuntimeSelection 命令读取和修改，只有 UUID 与显式 null 默认值可穿过选择合同。Main 持 native 登录凭据，重新确认目录权限并等待 Host 对应工作区清理后才返回新选择。

组件仅在原生织流桌面 composer 展示，复用既有 Button/DropdownMenu，不恢复个人 provider、key、模型或 OAuth 配置。仍保留上游上下文用量、压缩、原生工具和审批路径。请求失败显示固定提示，组件卸载/目标切换后忽略迟到结果。

验收：安全目录拒绝额外模型/密钥字段；工作区身份优先；Main/Host 并发和失效测试由其所属模块覆盖；运行中的本地任务拒绝切换，清理失败后不发新授权。

set 成功后仅调用当前目标的 `onSelectionChanged` 请求 Host 目录重读；失败、busy、工作区切换、账号失效或卸载后的迟到请求不能调用。账号变更只消费 DOM 失效事件，不传递账号或凭据。

`useZhiliuManagedDraftSelection` 消费 Toolbar 已有的当前 Host ModelSelectionState 和 Composer 下一轮选择，通过既有 `onSelectModel` 回调修复托管别名的失效/缺失 reasoning。只有 ready、无刷新错误、精确托管别名、单值 Host reasoning spec 才可更新；不创建第二份草稿，不改变正文/附件/权限/Plan，也不影响原供应商或已接受的任务。旧草稿恢复和档位更新复用这一条同步路径。
