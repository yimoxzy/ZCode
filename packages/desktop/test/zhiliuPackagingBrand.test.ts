import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const assetRoot = resolve(packageRoot, "build/zhiliu");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadConfig(zhiliu: boolean, platform = "win32") {
  vi.resetModules();
  vi.stubEnv("ZHILIU_DESKTOP", zhiliu ? "1" : "0");
  vi.stubEnv("ZCODE_ENV", "production");
  vi.stubEnv("ZCODE_TARGET_OS", platform);
  return (await import("../electron-builder.config.js")).default;
}

describe("织流安装包品牌资源", () => {
  it("uses the existing Zhiliu source icons for every native icon format", () => {
    const expected = {
      "icon.svg": "0b5838d4b4dbbffa250934acf7e80ff7c2c6c37dba705770dcb831a188526734",
      "icon.png": "9f6e781cc0fcece5272dd5da309c3220ccffc236c4923c6a554eee4e8254d498",
      "icon.ico": "767dc857a4fd46088f733baaf51f4d1402a8eea55b7f2b0c90797895e86b0298",
      "icon.icns": "3ec8f5e6c81388dbd6788e1ae102fa97098303f6e4bef570e02f4124cfad17de",
    };
    for (const [name, digest] of Object.entries(expected)) {
      expect(
        createHash("sha256")
          .update(readFileSync(resolve(assetRoot, name)))
          .digest("hex"),
      ).toBe(digest);
    }
    for (const [variant, original] of [
      ["icon_windows.png", "icon.png"],
      ["icon_installer.png", "icon.png"],
      ["icon_installer.ico", "icon.ico"],
      ["icon_installer.icns", "icon.icns"],
    ]) {
      expect(readFileSync(resolve(assetRoot, variant))).toEqual(
        readFileSync(resolve(assetRoot, original)),
      );
    }
  });

  it("provides correctly sized Linux PNG assets instead of renamed copies", () => {
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      const png = readFileSync(resolve(assetRoot, `icons/${size}x${size}.png`));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });

  it.each(["win32", "darwin", "linux"])(
    "maps %s package and runtime icon resources to the Zhiliu asset directory",
    async (platform) => {
      const config = await loadConfig(true, platform);
      expect(config.win?.icon).toBe("build/zhiliu/icon.ico");
      expect(config.mac?.icon).toBe("build/zhiliu/icon.icns");
      expect(config.linux?.icon).toBe("build/zhiliu/icons");
      const resources = config.extraResources as Array<{ from: string; to: string }>;
      for (const name of ["icon.png", "icon_windows.png"]) {
        expect(resources.find((resource) => resource.to === name)?.from).toBe(
          `build/zhiliu/${name}`,
        );
      }
      if (platform === "win32") {
        expect(resources.find((resource) => resource.to === "tray_icon.ico")?.from).toBe(
          "build/zhiliu/icon.ico",
        );
      }
      if (platform === "linux") {
        expect(resources.find((resource) => resource.to === "icon_512x512.png")?.from).toBe(
          "build/zhiliu/icons/512x512.png",
        );
      }
      for (const path of [
        config.win?.icon,
        config.mac?.icon,
        config.linux?.icon,
        config.nsis?.installerIcon,
        config.nsis?.uninstallerIcon,
        config.nsis?.installerHeaderIcon,
        config.dmg?.icon,
      ]) {
        expect(typeof path).toBe("string");
        expect(existsSync(resolve(packageRoot, path as string))).toBe(true);
      }
      expect(config.dmg?.background).toBeUndefined();
      expect(config.dmg?.backgroundColor).toBe("#F8FAFC");
      expect(config.dmg?.contents).not.toContainEqual(
        expect.objectContaining({ path: ".background.tiff" }),
      );
    },
  );

  it("presents the fork identity without the upstream support contact", async () => {
    const config = await loadConfig(true);
    expect(config.extraMetadata).toMatchObject({
      productName: "织流",
      description: "织流 AI Agent 工作台",
      author: { name: "织流" },
      homepage: "https://github.com/yimoxzy/ZCode",
    });
    expect(config.extraMetadata?.author).not.toHaveProperty("email");
    expect(config.linux?.maintainer).toBe("织流");
  });

  it("preserves upstream branding and installer assets when Zhiliu is disabled", async () => {
    const config = await loadConfig(false);
    expect(config.appId).toBe("dev.zcode.app");
    expect(config.productName).toBe("ZCode");
    expect(config.win?.icon).toBeUndefined();
    expect(config.mac?.icon).toBeUndefined();
    expect(config.linux?.icon).toBeUndefined();
    expect(config.nsis?.installerIcon).toBe("build/icon_installer.ico");
    expect(config.dmg?.icon).toBe("build/icon_installer.icns");
    expect(config.dmg?.background).toBe("build/dmg_background.png");
    expect(config.dmg?.backgroundColor).toBeUndefined();
    expect(config.extraMetadata?.author).toEqual({ name: "ZCode", email: "dev@zcode.z.ai" });
  });
});
