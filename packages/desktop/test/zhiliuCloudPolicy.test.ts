import { describe, expect, it } from "vitest";
import {
  buildZhiliuCloudWebPreferences,
  isZhiliuCloudNavigationAllowed,
  resolveZhiliuCloudTarget,
  safeZhiliuCloudDownloadName,
} from "../src/main/zhiliuCloudPolicy.js";

describe("织流云窗口地址和浏览器权限边界", () => {
  it.each([
    "https://saas.example.com",
    "https://saas.example.com/app/#/agent",
    "http://localhost:18780",
    "http://127.0.0.1:18780",
    "http://[::1]:18780",
  ])("允许 HTTPS 或 loopback 隧道：%s", (url) => {
    const target = resolveZhiliuCloudTarget(url);
    expect(new URL(target.url).hash).toBe("#/agent");
    expect(target.partition).toMatch(/^persist:zhiliu-cloud-[a-f0-9]{20}$/u);
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "http://saas.example.com",
    "http://100.68.196.62:18780",
    "http://localhost.example.com",
    "file:///C:/Users/private.txt",
    "javascript:alert(1)",
    "https://user:password@saas.example.com",
    "https://saas.example.com/?token=secret",
    "https://saas.example.com\n.evil.example.com",
    "https://saas.example.com\\@evil.example.com",
  ])("拒绝不可信地址且错误不回显输入：%s", (url) => {
    expect(() => resolveZhiliuCloudTarget(url)).toThrow(/ZHILIU_CLOUD_URL/u);
    try {
      resolveZhiliuCloudTarget(url);
    } catch (error) {
      expect(String(error)).not.toContain("password@");
      expect(String(error)).not.toContain("token=secret");
    }
  });

  it("同一 origin 共用云身份 partition，其他 origin 和端口隔离", () => {
    const base = resolveZhiliuCloudTarget("https://saas.example.com/#/agent");
    expect(resolveZhiliuCloudTarget("https://saas.example.com/#/knowledge").partition).toBe(
      base.partition,
    );
    expect(resolveZhiliuCloudTarget("https://other.example.com").partition).not.toBe(
      base.partition,
    );
    expect(resolveZhiliuCloudTarget("https://saas.example.com:8443").partition).not.toBe(
      base.partition,
    );
  });

  it("路由允许同源 hash 与 query，拒绝相似域名、降级和特权 scheme", () => {
    const origin = "https://saas.example.com";
    expect(isZhiliuCloudNavigationAllowed(`${origin}/#/agent/123`, origin)).toBe(true);
    expect(isZhiliuCloudNavigationAllowed(`${origin}/?view=preview`, origin)).toBe(true);
    for (const url of [
      "https://saas.example.com.evil.test",
      "http://saas.example.com",
      "file:///tmp/private",
      "javascript:alert(1)",
      "https://name:secret@saas.example.com",
    ]) {
      expect(isZhiliuCloudNavigationAllowed(url, origin)).toBe(false);
    }
  });

  it("仅允许子 frame 和下载使用同源 blob，不允许其变成顶层页面", () => {
    const origin = "https://saas.example.com";
    expect(isZhiliuCloudNavigationAllowed(`blob:${origin}/test-id`, origin)).toBe(false);
    expect(isZhiliuCloudNavigationAllowed(`blob:${origin}/test-id`, origin, true)).toBe(true);
    expect(isZhiliuCloudNavigationAllowed("blob:https://evil.test/test-id", origin, true)).toBe(
      false,
    );
    expect(isZhiliuCloudNavigationAllowed("data:text/html,hello", origin, true)).toBe(false);
  });

  it("远端页面无 Node、preload、webview 和跨域豁免", () => {
    const preferences = buildZhiliuCloudWebPreferences(
      resolveZhiliuCloudTarget("https://saas.example.com"),
    );
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(preferences).not.toHaveProperty("preload");
  });

  it("下载名称不能携带系统路径、Windows 保留名或非法字符", () => {
    expect(safeZhiliuCloudDownloadName("../../private/presentation.pptx")).toBe(
      "presentation.pptx",
    );
    expect(safeZhiliuCloudDownloadName("C:\\Windows\\evil?.exe")).toBe("evil_.exe");
    expect(safeZhiliuCloudDownloadName("CON.txt")).toBe("zhiliu-download");
    expect(safeZhiliuCloudDownloadName(".. ")).toBe("zhiliu-download");
  });
});
