import type { RuntimeGrant } from "./contract.js";
export const exampleRuntimeGrant: RuntimeGrant = {
  protocol_version: 1,
  grant_id: "00000000-0000-4000-8000-000000000001",
  runtime_grant: "rg_example_non_secret_0123456789",
  expires_at: "2099-01-01T00:00:00Z",
  gateway_base_url: "/api/runtime-gateway/v1",
  profile: {
    model: "zhiliu-managed",
    display_name: "织流托管模型",
    protocol: "chat_completions",
    max_context_tokens: 32768,
    max_output_tokens: 2048,
    reasoning_effort: null,
    inference_profile_id: null,
  },
};
