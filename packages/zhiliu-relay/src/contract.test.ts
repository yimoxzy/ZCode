import { describe, expect, it } from "vitest";
import { relayPrincipalSchema } from "./contract.js";
import { exampleRelayPrincipal } from "./contract.example.js";
describe("织流relay身份合同", () => {
  it("认证scope必须同时包含user和space，device必须绑定native ID", () => {
    expect(relayPrincipalSchema.safeParse(exampleRelayPrincipal).success).toBe(true);
    expect(
      relayPrincipalSchema.safeParse({
        ...exampleRelayPrincipal,
        principal_id: exampleRelayPrincipal.user_id,
      }).success,
    ).toBe(false);
    expect(
      relayPrincipalSchema.safeParse({ ...exampleRelayPrincipal, device_mid: "other-device" })
        .success,
    ).toBe(false);
    expect(
      relayPrincipalSchema.safeParse({ ...exampleRelayPrincipal, desktop_device_id: null }).success,
    ).toBe(false);
  });
});
