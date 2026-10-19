import type { MenuItemConstructorOptions } from "electron";
import { DesktopCommandIds, type Locale } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const environment = vi.hoisted(() => ({ managed: false, isPackaged: false }));
const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");

vi.mock("../../shared/src/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/src/env.js")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return environment.managed;
  },
  ZCODE_PRODUCT_FLAVOR: "production",
}));

const captured = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return environment.isPackaged;
    },
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      captured.template = template;
      return { template };
    },
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
}));

describe("desktop tray log export", () => {
  beforeEach(() => {
    vi.resetModules();
    captured.template = [];
    environment.managed = false;
    environment.isPackaged = false;
    Object.defineProperty(process, "resourcesPath", {
      value: join(import.meta.dirname, "fixtures", "resources"),
      configurable: true,
    });
  });

  afterEach(() => {
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, "resourcesPath", resourcesPathDescriptor);
    } else {
      delete (process as Partial<NodeJS.Process>).resourcesPath;
    }
  });

  it.each(["win32", "linux"] as const)(
    "%s replaces data deletion with localized log export and waits for the window",
    async (platform) => {
      const { createDesktopTray, updateWindowsDesktopTrayMenu } =
        await import("@desktop/main/desktopTray.js");
      let locale: Locale = "zh-CN";
      const windowReady = Promise.withResolvers<void>();
      const showCurrentWindow = vi.fn(() => windowReady.promise);
      const executeDesktopCommand = vi.fn(async () => undefined);
      createDesktopTray({
        platform,
        getLocale: () => locale,
        showCurrentWindow,
        executeDesktopCommand,
        quitApp: vi.fn(),
        logger: { warn: vi.fn() },
      });

      const labels = () => captured.template.map((item) => item.label).filter(Boolean);
      expect(labels()).not.toContain("清除所有数据");
      expect(labels().slice(-3)).toEqual(["关于 ZCode", "导出日志", "退出"]);
      locale = "en-US";
      updateWindowsDesktopTrayMenu();
      expect(labels()).not.toContain("Clear all data");
      expect(labels().slice(-3)).toEqual(["About ZCode", "Export logs", "Quit"]);

      const item = captured.template.find((entry) => entry.label === "Export logs");
      expect(item?.click).toBeDefined();
      // 模板回调不读取 Electron 事件参数；直接触发同一个原生菜单动作。
      (item!.click as () => void)();
      expect(showCurrentWindow).toHaveBeenCalledExactlyOnceWith();
      expect(executeDesktopCommand).not.toHaveBeenCalled();
      windowReady.resolve();
      await vi.waitFor(() =>
        expect(executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(DesktopCommandIds.ExportLogs),
      );
    },
  );

  it("织流托盘复用本地化菜单出口并隐藏上游更新，普通构建保留更新入口", async () => {
    for (const managed of [false, true]) {
      vi.resetModules();
      environment.managed = managed;
      const { createDesktopTray, updateWindowsDesktopTrayMenu } =
        await import("@desktop/main/desktopTray.js");
      let locale: Locale = "zh-CN";
      createDesktopTray({
        platform: "win32",
        getLocale: () => locale,
        showCurrentWindow: vi.fn(),
        executeDesktopCommand: vi.fn(),
        quitApp: vi.fn(),
        logger: { warn: vi.fn() },
      });
      let labels = captured.template.map((entry) => entry.label);
      expect(labels).toContain(managed ? "打开 织流" : "打开 ZCode");
      expect(labels.includes("检查更新")).toBe(!managed);
      locale = "en-US";
      updateWindowsDesktopTrayMenu();
      labels = captured.template.map((entry) => entry.label);
      expect(labels).toContain(managed ? "About 织流" : "About ZCode");
      expect(labels.includes("Check for updates")).toBe(!managed);
    }
  });

  it("开发态按构建身份取图标，打包态保持 extraResources 路径契约", async () => {
    for (const managed of [false, true]) {
      environment.managed = managed;
      const { resolveDesktopTrayIconPath } = await import("@desktop/main/desktopTray.js");
      const brandDirectory = managed ? "build/zhiliu" : "build";
      expect(resolveDesktopTrayIconPath("win32")).toContain(join(brandDirectory, "icon.ico"));
      expect(resolveDesktopTrayIconPath("linux")).toContain(join(brandDirectory, "icon.png"));
      environment.isPackaged = true;
      expect(resolveDesktopTrayIconPath("win32")).toBe(
        join(process.resourcesPath, "tray_icon.ico"),
      );
      expect(resolveDesktopTrayIconPath("linux")).toBe(join(process.resourcesPath, "icon.png"));
      environment.isPackaged = false;
    }
  });
});
