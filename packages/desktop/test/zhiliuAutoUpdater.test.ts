import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

const configuration = vi.hoisted(() => ({ source: "", install: false, publisher: "" }));
const mocks = vi.hoisted(() => ({
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => undefined),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  onBeforeRequest: vi.fn(),
  send: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  readFile: vi.fn(),
}));
const originalPlatform = process.platform;
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const updater = new EventEmitter();
Object.assign(updater, mocks);

vi.mock("@zcode/shared", async (original) => ({
  ...(await original<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
  get ZHILIU_UPDATE_MANIFEST_URL() {
    return configuration.source;
  },
  get ZHILIU_UPDATE_INSTALL_ENABLED() {
    return configuration.install;
  },
  get ZHILIU_UPDATE_PUBLISHER_NAME() {
    return configuration.publisher;
  },
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "3.15.1", on: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { id: 1, send: mocks.send } }],
  },
  Menu: { getApplicationMenu: () => null },
  ipcMain: { handle: mocks.handle, on: mocks.on },
  session: { fromPartition: () => ({ webRequest: { onBeforeRequest: mocks.onBeforeRequest } }) },
}));
vi.mock("electron-updater", () => ({
  default: {
    get autoUpdater() {
      return updater;
    },
  },
  Provider: class {},
  CancellationToken: class {},
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../src/main/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  updater.removeAllListeners();
  configuration.source = "";
  configuration.install = false;
  configuration.publisher = "";
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "C:/zhiliu/resources",
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else delete (process as Partial<NodeJS.Process>).resourcesPath;
});

describe("织流更新状态机接入", () => {
  it("未配置时所有检查入口无请求，即使 Main 传了上游运行时 feed", async () => {
    const module = await import("../src/main/autoUpdater.js");
    expect(module.getZhiliuAutoUpdaterInitOptions()).toEqual({ enabled: false });
    await module.initAutoUpdater({
      enabled: true,
      updateFeedSource: { url: "https://zcode.z.ai/manifest" },
    });
    module.requestAutoUpdateCheckWithoutWindow();
    module.requestForceAutoUpdate(vi.fn());
    module.checkForUpdateMenuClick({
      isDestroyed: () => false,
      webContents: { id: 1, send: mocks.send },
    } as never);
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateCheckResult,
      expect.objectContaining({ kind: "error", message: "尚未配置织流更新服务" }),
    );
  });

  it("自有来源启用检查，忽略上游覆写并对下载重定向再次检查来源", async () => {
    configuration.source = "https://updates.example.test/releases/manifest";
    const module = await import("../src/main/autoUpdater.js");
    const resolveEndpointOrigin = vi.fn(() => "https://zcode.z.ai");
    expect(module.getZhiliuAutoUpdaterInitOptions()).toEqual({ enabled: true });
    await module.initAutoUpdater({
      enabled: true,
      resolveEndpointOrigin,
      updateFeedSource: { url: "https://zcode.z.ai/manifest" },
    });
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({ zhiliuManifestUrl: configuration.source }),
    );
    expect(mocks.setFeedURL.mock.calls[0]?.[0]).not.toHaveProperty("endpointOrigin");
    expect(resolveEndpointOrigin).not.toHaveBeenCalled();
    const guard = mocks.onBeforeRequest.mock.calls[0]?.[1];
    const callback = vi.fn();
    guard({ url: "https://zcode.z.ai/redirected.exe" }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
    guard({ url: "https://updates.example.test/releases/app.exe" }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
  });

  it("技术版不因自动下载偏好、强更、下载或安装指令而运行安装", async () => {
    configuration.source = "https://updates.example.test/releases/manifest";
    const module = await import("../src/main/autoUpdater.js");
    await module.initAutoUpdater({
      enabled: true,
      settingService: {
        get: async () => ({ autoDownloadAndInstallUpdates: true }),
        update: vi.fn(),
      } as never,
    });
    updater.emit("update-available", { version: "4.0.0" });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    module.downloadAvailableUpdate();
    module.requestForceAutoUpdate(vi.fn());
    const install = mocks.handle.mock.calls.find(
      ([channel]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1];
    await expect(install()).rejects.toThrow("尚未开放下载安装");
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["https://zcode.z.ai/manifest", "https://updates.example.test/manifest"])(
    "非法来源或安装签名预检失败时完全关闭：%s",
    async (source) => {
      configuration.source = source;
      configuration.install = true;
      configuration.publisher = "Zhiliu Ltd";
      mocks.readFile.mockResolvedValue(
        "url: https://updates.example.test/\npublisherName:\n  - Other Publisher\n",
      );
      const module = await import("../src/main/autoUpdater.js");
      await module.initAutoUpdater({ enabled: true });
      module.requestAutoUpdateCheckWithoutWindow();
      expect(mocks.setFeedURL).not.toHaveBeenCalled();
      expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    },
  );
});
