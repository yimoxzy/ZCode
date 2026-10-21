# cli-managed-runtime

Host 或云 Worker 通过专用 stdin 启动首帧注入平台 Profile；只有 Bootstrap 装配层拥有它。
Registry 为不可写的内存快照，capability 只由模型 transport 持有，不进入配置、事件或工具环境。
业务指令通过 ContextSourcePort 追加，原有系统提示保持有效。显式插件 manifest 禁止宿主发现。
Loop、CommandInbox、Session、Tool、权限和恢复继续归原有 Runtime 所有。
参考 ../../../../docs/design/v2/managed-runtime.md。
