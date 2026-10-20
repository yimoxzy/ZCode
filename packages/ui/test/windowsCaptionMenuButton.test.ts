// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

const capturedDropdownContentProps = vi.hoisted(() => ({
  calls: [] as Array<{ align?: string; alignOffset?: number }>,
}));

const capturedWindowsCaptionMenu = vi.hoisted(() => {
  const screenshot = {
    dataBase64: "base64-image",
    filename: "zcode-error-2026-06-17.png",
    contentType: "image/png",
    size: 12,
  };

  return {
    zhiliu: false,
    screenshot,
    menuItems: [] as Array<{
      label: string;
      onSelect: (() => void | Promise<void>) | undefined;
    }>,
    openSubmit: vi.fn(),
    openFeatureRequest: vi.fn(),
    openExternal: vi.fn(),
    exportLogs: vi.fn(async () => ({ success: true })),
    captureWindowScreenshot: vi.fn(async () => screenshot),
    executeDesktopCommand: vi.fn(async () => undefined),
    canOpenCommunity: vi.fn(async () => true),
    getUpdateState: vi.fn(),
    openInFileManager: vi.fn(async () => ({ success: true })),
  };
});

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return capturedWindowsCaptionMenu.zhiliu;
  },
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuCheckboxItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({
    children,
    align,
    alignOffset,
  }: {
    children: ReactNode;
    align?: string;
    alignOffset?: number;
  }) => {
    capturedDropdownContentProps.calls.push({ align, alignOffset });
    return createElement("div", null, children);
  },
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void | Promise<void>;
  }) => {
    const label = Array.isArray(children)
      ? children.filter((child) => typeof child === "string").join("")
      : typeof children === "string"
        ? children
        : "";
    capturedWindowsCaptionMenu.menuItems.push({ label, onSelect });
    return createElement("div", null, children);
  },
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/ui/toast.js", () => ({
  dismissToast: vi.fn(),
  toast: vi.fn(() => 1),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      openSubmit: (draft?: unknown) => void;
      openFeatureRequest: () => void;
    }) => unknown,
  ) =>
    selector({
      openSubmit: capturedWindowsCaptionMenu.openSubmit,
      openFeatureRequest: capturedWindowsCaptionMenu.openFeatureRequest,
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => capturedWindowsCaptionMenu,
}));

beforeEach(() => {
  capturedWindowsCaptionMenu.zhiliu = false;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("WindowsCaptionMenuButton", () => {
  async function renderButton(
    triggerPresentation?: "header" | "header-borderless",
    useWindowsCaptionSpacing = false,
  ) {
    capturedDropdownContentProps.calls = [];
    capturedWindowsCaptionMenu.menuItems = [];
    const { WindowsCaptionMenuButton } = await import("@/WindowsCaptionMenuButton.js");
    // 快捷键特性后组件经 useShortcutCommandLabel 读设置，裸渲染需提供最小 ServiceProvider
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const { createSettingsTestServices } = await import("./lib/settingsTestServices.js");
    return renderToStaticMarkup(
      createElement(
        ServiceProvider,
        { services: createSettingsTestServices() },
        createElement(WindowsCaptionMenuButton, {
          workspaceAbsPath: "/workspace",
          onCreateTask: vi.fn(),
          onOpenWorkspace: vi.fn(),
          onToggleBrowser: vi.fn(),
          onToggleTerminal: vi.fn(),
          triggerPresentation,
          useWindowsCaptionSpacing,
        }),
      ),
    );
  }

  it("Preview 隐藏更新入口，生产版继续保留", async () => {
    const { shouldShowDesktopUpdateEntry } = await import("@/WindowsCaptionMenuButton.js");

    // 更新入口跟随产品身份：生产后端的 Preview 同样隐藏。
    expect(shouldShowDesktopUpdateEntry("preview")).toBe(false);
    expect(shouldShowDesktopUpdateEntry("production")).toBe(true);

    const html = await renderButton("header");
    expect(html).not.toContain("titleBar.menu.help.checkForUpdates");
  });

  it("includes help actions migrated from the shared question-mark menu", async () => {
    capturedWindowsCaptionMenu.openSubmit.mockClear();
    capturedWindowsCaptionMenu.openFeatureRequest.mockClear();
    capturedWindowsCaptionMenu.openExternal.mockClear();
    capturedWindowsCaptionMenu.exportLogs.mockClear();
    capturedWindowsCaptionMenu.captureWindowScreenshot.mockClear();

    const html = await renderButton("header");

    expect(html).toContain("titleBar.menu.help.feedback");
    expect(html).toContain("workspaceHeader.help.productRequest");
    expect(html).toContain("workspaceHeader.help.docs");
    expect(html).toContain("titleBar.menu.help.exportLogs");

    await capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "titleBar.menu.help.feedback")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "workspaceHeader.help.productRequest")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "workspaceHeader.help.docs")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "titleBar.menu.help.exportLogs")
      ?.onSelect?.();

    expect(capturedWindowsCaptionMenu.captureWindowScreenshot).not.toHaveBeenCalled();
    expect(capturedWindowsCaptionMenu.openSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bug",
        includeLogs: true,
        screenshots: [],
      }),
    );
    expect(capturedWindowsCaptionMenu.openFeatureRequest).toHaveBeenCalledTimes(1);
    expect(capturedWindowsCaptionMenu.openExternal).toHaveBeenCalledWith("https://zcode.z.ai/docs");
    expect(capturedWindowsCaptionMenu.exportLogs).toHaveBeenCalledTimes(1);
  });

  it("keeps the menu surface clear of the native Windows caption buttons", async () => {
    await renderButton("header");

    // Bugfix: Windows 原生 titleBarOverlay 宽度存在 DPI/取整差异，右对齐菜单需要轻微左移避开最小化按钮。
    expect(capturedDropdownContentProps.calls[0]).toMatchObject({
      align: "end",
      alignOffset: -12,
    });
  });

  it("keeps local support actions without querying or exposing upstream services in Zhiliu", async () => {
    capturedWindowsCaptionMenu.zhiliu = true;
    capturedWindowsCaptionMenu.menuItems = [];
    const { WindowsCaptionMenuButton } = await import("@/WindowsCaptionMenuButton.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const { createSettingsTestServices } = await import("./lib/settingsTestServices.js");
    const { container } = render(
      createElement(
        ServiceProvider,
        { services: createSettingsTestServices() },
        createElement(WindowsCaptionMenuButton, {
          workspaceAbsPath: "/workspace",
          onCreateTask: vi.fn(),
          onOpenWorkspace: vi.fn(),
          onToggleBrowser: vi.fn(),
          onToggleTerminal: vi.fn(),
        }),
      ),
    );

    const html = container.innerHTML;
    for (const label of [
      "workspaceHeader.help.productRequest",
      "sidebar.menu.community",
      "workspaceHeader.help.docs",
    ]) {
      expect(html).not.toContain(label);
    }
    expect(html).toContain("titleBar.menu.help.about");
    expect(html).toContain("titleBar.menu.help.resourceManager");
    expect(html).toContain("titleBar.menu.help.exportLogs");
    expect(capturedWindowsCaptionMenu.canOpenCommunity).not.toHaveBeenCalled();
    expect(capturedWindowsCaptionMenu.getUpdateState).toHaveBeenCalled();
    expect(capturedWindowsCaptionMenu.openExternal).not.toHaveBeenCalled();
    expect(capturedWindowsCaptionMenu.openSubmit).not.toHaveBeenCalled();
    const feedback = capturedWindowsCaptionMenu.menuItems.find(
      (item) => item.label === "titleBar.menu.help.feedback",
    );
    expect(feedback).toBeDefined();
    await feedback?.onSelect?.();
    expect(capturedWindowsCaptionMenu.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.OpenFeedback,
    );
    expect(capturedWindowsCaptionMenu.openSubmit).not.toHaveBeenCalled();
  });
});
