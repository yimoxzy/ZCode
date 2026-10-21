import type { ZhiliuManagedRuntimeProfile } from "./contract.js";
export const managedRuntimeExample: ZhiliuManagedRuntimeProfile = {
  version: 1,
  gatewayBaseUrl: "http://127.0.0.1:43121/v1",
  capabilityToken: "example_local_capability_0123456789",
  modelId: "zhiliu-managed",
  protocol: "chat_completions",
  maxContextTokens: 32768,
  maxOutputTokens: 2048,
};
