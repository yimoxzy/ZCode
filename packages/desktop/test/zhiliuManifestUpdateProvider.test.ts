import { NsisUpdater } from "electron-updater";
import { describe, expect, it, vi } from "vitest";
import { ManifestUpdateProvider } from "../src/main/manifestUpdateProvider.js";

vi.mock("@zcode/shared", async (original) => ({
  ...(await original<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));

const sha512 = Buffer.alloc(64).toString("base64");
const source = "https://updates.example.test/releases/manifest";

function createProvider(configuration: { zhiliuManifestUrl?: string } = {}) {
  const request = vi.fn(async (_options: unknown) =>
    JSON.stringify({ version: "4.0.0", files: [{ url: "/releases/zhiliu.exe", sha512 }] }),
  );
  const resolveEndpointOrigin = vi.fn(() => "https://zcode.z.ai");
  const provider = new ManifestUpdateProvider(
    {
      provider: "custom",
      manifestUrl: "https://zcode.z.ai/upstream",
      resolveEndpointOrigin,
      resolveReleaseChannel: () => "preview",
      ...configuration,
    },
    Object.create(NsisUpdater.prototype),
    { executor: { request } as never, platform: "win32", isUseMultipleRangeRequest: false },
  );
  return { provider, request, resolveEndpointOrigin };
}

describe("织流 manifest 不允许上游回退", () => {
  it("未配置固定来源或配置为官方源时在发请求前拒绝", () => {
    expect(() => createProvider()).toThrow("尚未配置织流更新服务");
    expect(() => createProvider({ zhiliuManifestUrl: "https://zcode.z.ai/manifest" })).toThrow();
  });

  it("只请求自有清单，保留通道协议并忽略旧官方 endpoint/feed", async () => {
    const { provider, request, resolveEndpointOrigin } = createProvider({
      zhiliuManifestUrl: source,
    });
    const manifest = await provider.getLatestVersion();
    expect(request).toHaveBeenCalledOnce();
    const options = request.mock.calls[0]?.[0] as unknown as { hostname: string; path: string };
    expect(options.hostname).toBe("updates.example.test");
    expect(options.path).toContain("channel=3");
    expect(resolveEndpointOrigin).not.toHaveBeenCalled();
    expect(provider.resolveFiles(manifest)[0]?.url.href).toBe(
      "https://updates.example.test/releases/zhiliu.exe",
    );
  });

  it("拒绝官方文件地址和仅有 SHA-2 的清单", () => {
    const { provider } = createProvider({ zhiliuManifestUrl: source });
    expect(() =>
      provider.resolveFiles({
        version: "4.0.0",
        files: [{ url: "https://zcode.z.ai/app.exe", sha512 }],
      }),
    ).toThrow();
    expect(() =>
      provider.resolveFiles({
        version: "4.0.0",
        files: [{ url: "/app.exe", sha2: "legacy" } as never],
      }),
    ).toThrow("SHA-512");
  });
});
