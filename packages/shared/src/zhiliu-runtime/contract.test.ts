import { describe, expect, it } from "vitest";
import { zhiliuManagedRuntimeProfileSchema } from "./contract.js";
import { managedRuntimeExample } from "./contract.example.js";
describe("可信托管运行时profile", () => {
  it("image capability is an optional boolean with no implicit new authorization", () => {
    for (const supportsImage of [true, false, undefined]) {
      expect(zhiliuManagedRuntimeProfileSchema.parse({...managedRuntimeExample, supportsImage}).supportsImage).toBe(supportsImage);
    }
    expect(zhiliuManagedRuntimeProfileSchema.safeParse({...managedRuntimeExample, supportsImage: "true"}).success).toBe(false);
  });
  it("单次审批工具必须为平台工具且属于可用工具清单", () => {
    const name = "mcp__zhiliu_platform__save_personal_memory";
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        toolAllowlist: [name],
        approvalRequiredTools: [name],
      }).success,
    ).toBe(true);
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        toolAllowlist: [],
        approvalRequiredTools: [name],
      }).success,
    ).toBe(false);
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        approvalRequiredTools: [name],
      }).success,
    ).toBe(true);
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        approvalRequiredTools: [name, name],
      }).success,
    ).toBe(false);
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        toolAllowlist: ["Write"],
        approvalRequiredTools: ["Write"],
      }).success,
    ).toBe(false);
  });
  it("接受本机profile且拒绝额外secret", () => {
    expect(zhiliuManagedRuntimeProfileSchema.parse(managedRuntimeExample).version).toBe(1);
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        runtime_grant: "secret",
      }).success,
    ).toBe(false);
  });
  it.each([
    "https://127.0.0.1:42/v1",
    "http://localhost:42/v1",
    "http://127.0.0.1:42/v1?x=1",
    "http://127.0.0.1:42/evil",
    "http://127.0.0.1:42/v1#x",
  ])("拒绝非固定broker地址 %s", (gatewayBaseUrl) => {
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({ ...managedRuntimeExample, gatewayBaseUrl })
        .success,
    ).toBe(false);
  });
  it("平台工具必须使用独立capability和固定本机mcp路径", () => {
    const platformTools = {
      url: "http://127.0.0.1:42/mcp",
      capabilityToken: "separate_tool_capability_12345678901234567890",
    };
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({ ...managedRuntimeExample, platformTools })
        .success,
    ).toBe(true);
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        platformTools: { ...platformTools, capabilityToken: managedRuntimeExample.capabilityToken },
      }).success,
    ).toBe(false);
    expect(
      zhiliuManagedRuntimeProfileSchema.safeParse({
        ...managedRuntimeExample,
        platformTools: { ...platformTools, url: "https://external.invalid/mcp" },
      }).success,
    ).toBe(false);
  });
});
