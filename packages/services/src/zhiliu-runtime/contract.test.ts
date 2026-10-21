import { describe, expect, it } from "vitest";
import { runtimeGrantSchema } from "./contract.js";
import { exampleRuntimeGrant } from "./contract.example.js";
describe("平台runtime grant", () => {
  it("固定网关路径，拒绝上游地址或额外密钥", () => {
    expect(runtimeGrantSchema.parse(exampleRuntimeGrant).profile.model).toBe("zhiliu-managed");
    expect(
      runtimeGrantSchema.safeParse({
        ...exampleRuntimeGrant,
        gateway_base_url: "https://example.com",
      }).success,
    ).toBe(false);
    expect(runtimeGrantSchema.safeParse({ ...exampleRuntimeGrant, api_key: "wrong" }).success).toBe(
      false,
    );
  });
});
