// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executeDesktopCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  forbiddenHook: vi.fn(() => {
    throw new Error("upstream model hooks must not mount");
  }),
}));
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => state,
  useSelectDirectory: () => state.forbiddenHook,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: state.forbiddenHook,
  useOptionalServices: state.forbiddenHook,
}));
vi.mock("@/hooks/useOAuth.js", () => ({ useOAuth: state.forbiddenHook }));
vi.mock("@/hooks/useModelProviders.js", () => ({ useModelProviders: state.forbiddenHook }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { DesktopCommandIds } from "@zcode/shared";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { ConversationComposer, type ConversationComposerProps } from "@/v4/ConversationComposer.js";
import { LoginPanel } from "@/WelcomeScreen.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "@/lib/settingsNavigation.js";
import { createSettingsPageConfig } from "@/settings/settingsPageConfig.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.executeDesktopCommand.mockResolvedValue({ opened: true });
});
afterEach(cleanup);

describe("织流仅平台授权的 UI 边界", () => {
  it("设置目录和旧导航都不能进入个人模型或迁移配置，保留项目能力入口", () => {
    expect(isSettingsSectionEnabled("modelProvider")).toBe(false);
    expect(isSettingsSectionEnabled("migration")).toBe(false);
    expect(resolveSettingsSection("modelProvider")).toBe("general");
    const { settingsSections } = createSettingsPageConfig({ isDesktop: true });
    expect(settingsSections.some((item) => item.id === "modelProvider")).toBe(false);
    expect(settingsSections.some((item) => item.id === "skill")).toBe(true);
    expect(settingsSections.some((item) => item.id === "mcp")).toBe(true);
  });

  it("直接挂载个人配置页和上游登录面板也不触发读取/写入 hook", () => {
    const form = render(createElement(ModelProviderSection));
    expect(screen.getByTestId("zhiliu-cloud-access-notice")).toBeTruthy();
    expect(form.container.querySelector("input")).toBeNull();
    form.unmount();
    render(createElement(LoginPanel, { active: true, onComplete: vi.fn() }));
    expect(screen.getByRole("button", { name: "登录云 Agent" })).toBeTruthy();
    expect(state.forbiddenHook).not.toHaveBeenCalled();
  });

  it("聊天不挂载本地输入/附件预热 hook，云入口只提交固定平台命令", async () => {
    const onSendText = vi.fn();
    render(
      createElement(ConversationComposer, { onSendText } as unknown as ConversationComposerProps),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "登录云 Agent" }));
    await waitFor(() =>
      expect(state.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
        DesktopCommandIds.OpenZhiliuCloud,
      ),
    );
    expect(onSendText).not.toHaveBeenCalled();
    expect(state.forbiddenHook).not.toHaveBeenCalled();
  });

  it("旧上游模型目录不会显示或调用选择/管理动作", () => {
    const onValueChange = vi.fn();
    const onManageModels = vi.fn();
    const { container } = render(
      createElement(ModelConfigSelect, {
        modelGroups: [
          {
            key: "custom",
            label: "private upstream",
            items: [{ key: "m", value: "m", name: "secret model" }],
          },
        ],
        normalizedValue: "m",
        triggerLabel: "secret model",
        showManageModelsAction: true,
        lockReasonMessage: "",
        isItemLocked: () => false,
        onValueChange,
        onManageModels,
      }),
    );
    expect(container.innerHTML).toBe("");
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onManageModels).not.toHaveBeenCalled();
  });

  it("首启跳过上游引导，不遮住本地项目壳", () => {
    render(
      createElement(OccupationOnboarding, {
        children: createElement("div", null, "project shell"),
      }),
    );
    expect(screen.getByText("project shell")).toBeTruthy();
    const result = render(createElement(OnboardingDialog, {}));
    expect(result.container.innerHTML).toBe("");
    expect(state.forbiddenHook).not.toHaveBeenCalled();
  });
});
