import type { ZhiliuRuntimeWorkspace } from "@zcode/shared";
/** Presentation only; Main owns account, grant, effective selection, and runtime invalidation. */
export interface ZhiliuRuntimeSelectProps extends ZhiliuRuntimeWorkspace {
  disabled: boolean;
}
