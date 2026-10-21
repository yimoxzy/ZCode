import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";
export type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";

/** 可信启动参数；不是公开 RPC 或用户配置。 */
export interface ManagedRuntimeOptions {
  managedRuntimeProfile?: ZhiliuManagedRuntimeProfile;
}

export const MANAGED_PROVIDER_ID = "zhiliu-managed";
export const MANAGED_MODEL_ID = "zhiliu-managed";
export const MANAGED_PLACEHOLDER_KEY = "managed-runtime-auth-is-transport-owned";
