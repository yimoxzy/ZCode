# 托管执行边界

Main仅通过私有端口发行/撤销短期授权，Host唯一拥有broker，CLI只得到本机capability。`resolve`按工作区single-flight，`invalidate`同步关准入并等待broker与CLI清理，`dispose`永久关闭。平台profile为只读目录事实，不允许个人供应商覆盖。协议见 `specs/zhiliu-managed-runtime.md`；服务端是模型路由、幂等和计费的唯一权威。

`readProfile(target)` 只返回既有工作区授权，无 target 时为空。`createManagedWorkspaceModelSelectionService` 复用该权威派生各工作区的只读模型目录；`getView` 必须带 `workspace` 才能返回可执行选择。事件仅广播失效信号，消费者应按自己的 target 重读。派生目录不拥有授权、任务或计费状态；失效和 dispose 拒绝旧异步读取，不能回退到其他工作区。
