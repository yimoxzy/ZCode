# CLI plugin discovery

唯一职责是按既有顺序返回候选插件路径；请求来自 PluginDiscoverRequest，只读取官方分片和安装记录。调用方提供 diagnostics、取消信号；不保存实例、不修改配置、不执行 Hook。

普通模式保留 inline、显式官方目录、bundled 当前版本缓存、市场安装来源；approved-only 只处理 `config.dirs`，不触碰其他来源。缺失缓存返回空；原有非缺失扫描异常追加 warning。NodePluginAdapter 仍拥有解析、重复 ID、启用、组件组合和 Hook 规则。

边界是同步只读 adapter。公开入口为 `resolveNodePluginCandidates` 与函数契约；抽离不改变既有普通 CLI 行为。contract tests 和既有 plugins/managed-runtime 测试验证普通来源次序、当前版本指针、仅批准目录和禁用缓存发现。
