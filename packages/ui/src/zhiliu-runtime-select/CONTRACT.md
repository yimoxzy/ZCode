# 织流桌面 Agent 与思考档位选择

该模块只投影 Main 返回的平台目录和当前项目选择。输入为现有 workspacePath、workspaceIdentity 与运行期 disabled；工作区身份优先，不自行维护账户、价格、任务、模型配置或长期选择真相。

通过既有 platform.executeDesktopCommand 的 getZhiliuRuntimeSelection/setZhiliuRuntimeSelection 命令读取和修改，只有 UUID 与显式 null 默认值可穿过选择合同。Main 持 native 登录凭据，重新确认目录权限并等待 Host 对应工作区清理后才返回新选择。

组件仅在原生织流桌面 composer 展示，复用既有 Button/DropdownMenu，不恢复个人 provider、key、模型或 OAuth 配置。仍保留上游上下文用量、压缩、原生工具和审批路径。请求失败显示固定提示，组件卸载/目标切换后忽略迟到结果。

验收：安全目录拒绝额外模型/密钥字段；工作区身份优先；Main/Host 并发和失效测试由其所属模块覆盖；运行中的本地任务拒绝切换，清理失败后不发新授权。

set 成功后仅调用当前目标的 `onSelectionChanged` 请求 Host 目录重读；失败、busy、工作区切换、账号失效或卸载后的迟到请求不能调用。账号变更只消费 DOM 失效事件，不传递账号或凭据。

挂载、target 变化和账号失效后自动通过既有 Get 读取显示投影；未读/读取失败不能显示成默认选择。显示回执绑定当前 target，旧代次不得覆盖新项目。运行期 disabled 不阻止只读获取，仍阻止 Set；打开菜单可再次只读刷新。该读取不写草稿、不触发 `onSelectionChanged`，不创建第二份选择缓存。

思考档位复用 `ComposerModelMenu.tsx` 导出的纯 `ComposerEffortSlider`，不启用整个模型/供应商菜单。纯 props 为已声明的 `levels[{value,label,inactive?}]`、受控 value、label/shortcutLabel、disabled、visualKey、highspeed 与 onValueChange；组件不读取业务服务或写选择。织流 levels 仅由 Main catalog 的 profile UUID/name 按原顺序生成，默认 UI sentinel 只在既有 Set 中转成 null；不消费 Host reasoning 作为候选列表。Main 成功回执前保留原受控选择，失败、等待及迟到响应不能乐观改动滑杆/标题或草稿；Agent UUID 随原选择保留。

`useZhiliuManagedDraftSelection` 消费 Toolbar 已有的当前 Host ModelSelectionState 和 Composer 下一轮选择，通过既有 `onSelectModel` 回调修复托管别名的失效/缺失 reasoning。只有 ready、无刷新错误、精确托管别名、单值 Host reasoning spec 才可更新；不创建第二份草稿，不改变正文/附件/权限/Plan，也不影响原供应商或已接受的任务。旧草稿恢复和档位更新复用这一条同步路径。
