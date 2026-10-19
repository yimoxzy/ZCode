import { describe, expect, it } from "vitest";
import { resolveApplicationMessage } from "../src/i18n/applicationMessages.js";

describe("Zhiliu application message boundaries", () => {
  it("brands application identity in both supported languages", () => {
    expect(
      resolveApplicationMessage("zh-CN", "startup.global.silent", "正在启动 ZCode", true),
    ).toBe("正在启动 织流");
    expect(
      resolveApplicationMessage("en-US", "titleBar.menu.help.about", "About ZCode", true),
    ).toBe("About Zhiliu");
  });

  it("keeps user substitution values outside branding", () => {
    const template = resolveApplicationMessage(
      "en-US",
      "resourceManager.storage.diskUsage",
      "ZCode uses {used}",
      true,
    );
    expect(template.replaceAll("{used}", "ZCode-project 20 MB")).toBe(
      "Zhiliu uses ZCode-project 20 MB",
    );
  });

  it("preserves real upstream services and engine identities", () => {
    expect(
      resolveApplicationMessage("zh-CN", "ssh.assetInstallModeDescription", "连接 ZCode CDN", true),
    ).toBe("连接 ZCode CDN");
    expect(
      resolveApplicationMessage("en-US", "server.description", "Connect to ZCode server.", true),
    ).toBe("Connect to ZCode server.");
    expect(
      resolveApplicationMessage("zh-CN", "settings.skills.agent.glm", "ZCode Agent", true),
    ).toBe("ZCode Agent");
  });

  it("preserves upstream builds and unknown message content", () => {
    expect(resolveApplicationMessage("en-US", "login.title", "Welcome to ZCode", false)).toBe(
      "Welcome to ZCode",
    );
    expect(
      resolveApplicationMessage("en-US", "external.plugin.title", "ZCode integration", true),
    ).toBe("ZCode integration");
  });
});
