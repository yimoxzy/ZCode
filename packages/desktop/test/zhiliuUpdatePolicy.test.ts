import { describe, expect, it } from "vitest";
import {
  assertZhiliuUpdateArtifact,
  assertZhiliuUpdateSigningConfiguration,
  buildZhiliuUpdatePublishConfiguration,
  isZhiliuUpdateRequestAllowed,
  resolveZhiliuUpdateBuildPolicy,
  resolveZhiliuUpdatePolicy,
} from "../src/main/zhiliuUpdatePolicy.js";

const manifestUrl = "https://updates.example.test/releases/manifest";
const sha512 = Buffer.alloc(64).toString("base64");

describe("织流固定更新来源与发布者策略", () => {
  it("没有自己的来源时不生成 publish 配置，不读取上游 feed", () => {
    const policy = resolveZhiliuUpdateBuildPolicy({ ZCODE_UPDATE_FEED_URL: manifestUrl });
    expect(policy).toMatchObject({ manifestUrl: null, installEnabled: false });
    expect(buildZhiliuUpdatePublishConfiguration(policy)).toBeNull();
  });

  it.each([
    "http://updates.example.test/manifest",
    "file:///updates/manifest",
    "not-url",
    "https://name:secret@updates.example.test/manifest",
    "https://updates.example.test/manifest?token=secret",
    "https://updates.example.test/manifest#stable",
    "https://updates.example.test/manifest?",
    "https://zcode.z.ai/api/v1/releases/electron/manifest",
    "https://updates.example.test\\evil/manifest",
    "https://updates.example.test/up\ndates",
  ])("拒绝非法或上游更新地址：%s", (url) => {
    expect(() => resolveZhiliuUpdatePolicy({ manifestUrl: url })).toThrow();
  });

  it("合法来源默认仅检查，Windows 安装必须固定自己的签名发布者", () => {
    expect(resolveZhiliuUpdatePolicy({ manifestUrl }).installEnabled).toBe(false);
    expect(() => resolveZhiliuUpdatePolicy({ manifestUrl, installEnabled: true }, "win32")).toThrow(
      "发布者",
    );
    const policy = resolveZhiliuUpdatePolicy(
      { manifestUrl, installEnabled: true, publisherName: "Zhiliu Ltd" },
      "win32",
    );
    const publish = buildZhiliuUpdatePublishConfiguration(policy);
    expect(publish).toMatchObject({
      provider: "generic",
      url: "https://updates.example.test/releases/",
      publisherName: ["Zhiliu Ltd"],
    });
    expect(() =>
      assertZhiliuUpdateSigningConfiguration(
        policy,
        { ...publish, updaterCacheDirName: "zhiliu-desktop-updater" },
        "win32",
      ),
    ).not.toThrow();
    for (const config of [
      {},
      { ...publish, publisherName: ["Other"] },
      { ...publish, publisherName: ["Zhiliu Ltd", "Other"] },
      { ...publish, url: "https://zcode.z.ai/" },
    ]) {
      expect(() => assertZhiliuUpdateSigningConfiguration(policy, config, "win32")).toThrow();
    }
  });

  it("仅允许同源 HTTPS 安装包与有效 SHA-512", () => {
    expect(() =>
      assertZhiliuUpdateArtifact("/releases/zhiliu.exe", sha512, manifestUrl),
    ).not.toThrow();
    for (const path of [
      "https://zcode.z.ai/app.exe",
      "http://updates.example.test/app.exe",
      "https://other.example.test/app.exe",
      "/app.exe?token=secret",
      "/app.exe#download",
      "https://user:secret@updates.example.test/app.exe",
    ]) {
      expect(() => assertZhiliuUpdateArtifact(path, sha512, manifestUrl)).toThrow();
    }
    for (const hash of [undefined, "", "sha2-only", "invalid-sha512"]) {
      expect(() => assertZhiliuUpdateArtifact("/app.exe", hash, manifestUrl)).toThrow("SHA-512");
    }
  });

  it("网络边界复核重定向，清单只允许既有 platform/device_mid/channel 参数", () => {
    expect(
      isZhiliuUpdateRequestAllowed(
        `${manifestUrl}?platform=windows-x86_64&device_mid=own-device&channel=3`,
        manifestUrl,
      ),
    ).toBe(true);
    expect(
      isZhiliuUpdateRequestAllowed(
        "https://updates.example.test/releases/zhiliu.exe.blockmap",
        manifestUrl,
      ),
    ).toBe(true);
    for (const url of [
      "https://zcode.z.ai/app.exe",
      "http://updates.example.test/app.exe",
      `${manifestUrl}?token=secret`,
      `${manifestUrl}?channel=1&channel=3`,
      `${manifestUrl}?channel=other`,
      "https://updates.example.test/app.exe?download=1",
    ]) {
      expect(isZhiliuUpdateRequestAllowed(url, manifestUrl)).toBe(false);
    }
  });
});
