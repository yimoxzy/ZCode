import type { ManagedRequestSecurityProfile } from "./contract.js";
export const managedSecurityExample: ManagedRequestSecurityProfile = {
  version: 1, gatewayBaseUrl: "http://127.0.0.1:32100/v1",
  capabilityToken: "example_local_capability_12345678901234567890",
  modelId: "zhiliu-managed", protocol: "responses",
  maxContextTokens: 128000, maxOutputTokens: 4096,
};
