import { describe, expect, it } from "vitest";
import { zhiliuRuntimeCatalogSchema, zhiliuRuntimeSelectionInputSchema } from "@zcode/shared";
import { exampleRuntimeSelectProps } from "./contract.example.js";

describe("Native Agent selector display contract", () => {
  it("accepts workspace identity and explicit null defaults without allowing model/key settings", () => {
    const { disabled: _disabled, ...workspace } = exampleRuntimeSelectProps;
    const input = { ...workspace, selection: { agent_id: null, inference_profile_id: null } };
    expect(zhiliuRuntimeSelectionInputSchema.safeParse(input).success).toBe(true);
    expect(
      zhiliuRuntimeSelectionInputSchema.safeParse({ ...input, model: "upstream-model" }).success,
    ).toBe(false);
  });
  it("rejects catalog response carrying a model, credential, or server URL", () => {
    const catalog = { protocol_version: 1, agents: [], inference_profiles: [] };
    expect(zhiliuRuntimeCatalogSchema.safeParse(catalog).success).toBe(true);
    for (const field of ["model", "api_key", "gateway_base_url", "runtime_grant"])
      expect(
        zhiliuRuntimeCatalogSchema.safeParse({ ...catalog, [field]: "forbidden" }).success,
      ).toBe(false);
  });
});
