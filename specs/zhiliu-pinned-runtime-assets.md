# 固定运行时资源的字节完整性

## 已验证根因

Windows 的 `core.autocrlf=true` 会在检出文本文件时将 LF 改为 CRLF。Gen UI vendor 和 runtime 清单保存的是上游 Git blob 的 SHA-256；本机检出的 JS、CSS、HTML、LICENSE 因换行转换而与该摘要不符，导致桌面资源复制阶段拒绝构建。这些 Git blob 本身与现有清单一致，不是资源供应链更新。

## 约束与修复

- `apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/**` 和 `packages/desktop/src/renderer/src/plugin-sandbox/genUiTweakRuntime.js` 按原始字节检出，使用 `.gitattributes` 的 `-text`，不进行自动换行转换。
- 保持清单摘要与现有构建校验不变，不在构建阶段静默修正资源或重写摘要。
- 当前受影响工作树只在确认文件与 Git blob 的差别完全来自 CRLF 后恢复原始 blob；保留其他开发改动。
- 新增真实 Git 检出回归：固定快照经 `core.autocrlf=true` 的临时仓库检出后，字节必须与输入保持一致；现有 vendor/runtime 校验继续执行。

后续升级资源应同时审查来源、许可和清单摘要。`-text` 保护已有快照的原字节，不替代真实性或完整性校验。
