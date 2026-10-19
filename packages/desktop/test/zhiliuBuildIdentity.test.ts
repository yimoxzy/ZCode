import { describe, expect, it } from "vitest";
import { createZhiliuBuildEnv } from "../../../scripts/build-zhiliu-desktop.mjs";
import {
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelId,
} from "../scripts/desktop-product-identity.mjs";

describe("Zhiliu installer identity", () => {
  it("keeps the fork installer and Windows Shell separate from upstream", () => {
    const env = createZhiliuBuildEnv({ ZHILIU_CLOUD_URL: "https://example.test" });
    const identity = resolveDesktopProductIdentity(env);
    expect(identity.appId).toBe("ai.zhiliu.desktop");
    expect(identity.productName).toBe("织流");
    expect(resolveWindowsAppUserModelId(env)).toBe(identity.appId);
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "production" }).appId).toBe("dev.zcode.app");
  });

  it("sets a single compile identity and disables upstream telemetry and updates", () => {
    const env = createZhiliuBuildEnv({
      ZHILIU_CLOUD_URL: "http://127.0.0.1:18780",
      ZCODE_ARMS_RUM_ENDPOINT: "https://telemetry.example.test",
      ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://telemetry.example.test/events",
      ZCODE_AUTO_UPDATE: "true",
    });
    expect(env.ZHILIU_DESKTOP).toBe("1");
    expect(env.ZHILIU_CLOUD_URL).toBe("http://127.0.0.1:18780/#/agent");
    expect(env.ZCODE_ARMS_RUM_ENDPOINT).toBe("");
    expect(env.ZCODE_TELEMETRY_REPORT_ENDPOINT).toBe("");
    expect(env.ZCODE_AUTO_UPDATE).toBe("false");
  });

  it("refuses to package an absent, credential-bearing or insecure service address", () => {
    for (const value of [undefined, "http://example.test", "https://user:password@example.test"]) {
      expect(() => createZhiliuBuildEnv({ ZHILIU_CLOUD_URL: value })).toThrow();
    }
  });
});
