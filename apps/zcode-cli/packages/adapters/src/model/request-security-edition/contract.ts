import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";
import type { ModelRequestSecurityState } from "../request-security.js";

/** Trusted bootstrap input; capability stays in the transport closure. */
export type ManagedRequestSecurityProfile = ZhiliuManagedRuntimeProfile;
export type CreateManagedRequestSecurity = (profile?: ManagedRequestSecurityProfile) => ModelRequestSecurityState;
