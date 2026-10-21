import { describe, expect, it, vi } from "vitest";
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));
import { PluginsSection } from "@/settings/PluginsSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { ZhiliuCloudAccessNotice } from "@/root/ZhiliuCloudAccessNotice.js";

describe("织流品牌保留上游能力入口", () => {
  it("插件设置仍进入原插件/Skill/MCP实现并保留空间参数", () => {
    const props = {
      onOpenPluginStore: vi.fn(),
      initialTab: "skills" as const,
      workspacePath: "C:/project",
      workspaceIdentity: "space-one",
    };
    const rendered = PluginsSection(props);
    expect(rendered.type).not.toBe(ZhiliuCloudAccessNotice);
    expect(rendered.props).toEqual(props);
  });
  it("自动化设置仍进入原实现并保留来源工作区", () => {
    const props = {
      workspacePath: "C:/project",
      workspaceIdentity: "space-one",
      onCreateViaChat: vi.fn(),
    };
    const rendered = AutomationsSection(props);
    expect(rendered.type).not.toBe(ZhiliuCloudAccessNotice);
    expect(rendered.props).toEqual(props);
  });
});
