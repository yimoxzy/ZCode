import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type IpcHandler = (...args: unknown[]) => unknown;
type RemoteIpcOptions = Parameters<
  typeof import("../src/main/desktopMainIpcRemote.js").registerRemoteIpcHandlers
>[0];

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  registerWebRemoteControlIpcHandlers: vi.fn(),
  shellOpenExternal: vi.fn(),
  shellOpenPath: vi.fn(),
  realpath: vi.fn(),
  configureRemoteUsageArmsTelemetry: vi.fn(),
  reportRemoteConnectResultToArms: vi.fn(),
}));

// 文件存在性与 URL 转换无关，避免 UNC 场景实际访问网络共享；保留真实 node:url 语义。
vi.mock("node:fs/promises", () => ({ realpath: h.realpath }));

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => h.listeners.set(channel, handler)),
  },
  shell: {
    openExternal: h.shellOpenExternal,
    openPath: h.shellOpenPath,
  },
}));

vi.mock("../src/main/desktopNotifications.js", () => ({
  dispatchTaskNotification: vi.fn(),
}));

vi.mock("../src/main/desktopOAuthDeepLink.js", () => ({
  clearOAuthRoutesForWindow: vi.fn(),
  deliverPendingDeepLink: vi.fn(() => false),
  parseOAuthStateRegistration: vi.fn(),
  registerOAuthState: vi.fn(),
}));

vi.mock("../src/main/desktopArmsCustomEvent.js", () => ({
  createFinalArmsCustomEventE2EController: vi.fn(),
  dispatchFinalArmsCustomEvent: vi.fn(),
}));

vi.mock("../src/main/desktopWebRemoteControlIpc.js", () => ({
  registerWebRemoteControlIpcHandlers: h.registerWebRemoteControlIpcHandlers,
}));

vi.mock("../src/main/desktopRemoteUsageArmsTelemetry.js", () => ({
  configureRemoteUsageArmsTelemetry: h.configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms: h.reportRemoteConnectResultToArms,
}));

function createOptions(): RemoteIpcOptions {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    appTelemetryRuntime: {
      onRendererReady: vi.fn(),
      syncRendererContext: vi.fn(),
      onOAuthCallbackHandled: vi.fn(),
    },
    appTelemetryCore: {
      reportEvent: vi.fn(async () => {}),
    },
    reportRemoteUsageEvent: vi.fn(),
    armsCustomContext: {
      deviceMid: "device-mid",
      platform: "darwin",
      appVersion: "1.0.0",
      armsEnv: "local",
    },
    webRemoteControlManager: {
      authorizeStart: vi.fn(),
      startAuthorized: vi.fn(),
      resetPairingAuthorized: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
    },
    createRemoteWorkspaceSession: vi.fn(async () => "remote-session-1"),
    disposeRemoteWorkspaceSession: vi.fn(),
    cancelPendingRemoteWorkspaceSessionsForWindow: vi.fn(),
    bindRemoteWorkspaceSessionContext: vi.fn(),
    confirmRendererAttachmentReady: vi.fn(),
    getRemoteConnectionStats: vi.fn(() => ({
      activeSessionCount: 0,
      activeTargetCount: 0,
    })),
    isDockerDaemonAvailable: vi.fn(async () => true),
    listAvailableWSLDistros: vi.fn(async () => []),
    listAvailableDockerContainers: vi.fn(async () => []),
    listSSHConfigAliases: vi.fn(async () => []),
  };
}

async function registerOpenExternalListener() {
  const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
  const options = createOptions();
  registerRemoteIpcHandlers(options);
  const listener = h.listeners.get(PlatformChannels.OpenExternal);
  expect(listener).toBeDefined();
  return { listener: listener!, options };
}

describe("OpenExternal 对 file URL 的分流", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
    h.shellOpenExternal.mockReset().mockResolvedValue(undefined);
    h.shellOpenPath.mockReset().mockResolvedValue("");
    h.realpath.mockReset().mockImplementation(async (path: string) => path);
  });

  it("中文与空格的 file URL 走 shell.openPath 且收到解码后的本地路径", async () => {
    const { listener } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };
    // Windows 必须包含盘符，POSIX 使用根路径；不要将单一平台的 URL 当作通用有效路径。
    const filePath = join(tmpdir(), "zcode-open-external-fixtures", "04 素材", "page.html");

    listener({ sender }, pathToFileURL(filePath).href);

    await vi.waitFor(() => expect(h.shellOpenPath).toHaveBeenCalledTimes(1));
    expect(h.shellOpenPath).toHaveBeenCalledWith(filePath);
    expect(h.shellOpenPath).not.toHaveBeenCalledWith(expect.stringContaining("%"));
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("带锚点的 file URL 剥掉 hash 后仍走 shell.openPath", async () => {
    const { listener } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };
    const filePath = join(tmpdir(), "zcode-open-external-fixtures", "report.html");
    const fileUrl = pathToFileURL(filePath);
    fileUrl.hash = "section";

    listener({ sender }, fileUrl.href);

    await vi.waitFor(() => expect(h.shellOpenPath).toHaveBeenCalledTimes(1));
    expect(h.shellOpenPath).toHaveBeenCalledWith(filePath);
    expect(h.shellOpenPath).not.toHaveBeenCalledWith(expect.stringContaining("#"));
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("http URL 仍走 shell.openExternal", async () => {
    const { listener } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    listener({ sender }, "https://example.com/docs");

    await vi.waitFor(() => expect(h.shellOpenExternal).toHaveBeenCalledTimes(1));
    expect(h.shellOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(h.shellOpenPath).not.toHaveBeenCalled();
  });

  it("file URL 无法转换为本地路径时记录 warn 且不回退到 shell.openExternal", async () => {
    const { listener, options } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    // Node 在 Windows 上接受 UNC，不能用远端主机作为通用非法样本；编码分隔符各平台都拒绝。
    listener({ sender }, "file:///C:/report%2Fname.html");

    await vi.waitFor(() => expect(options.logger.warn).toHaveBeenCalledTimes(1));
    expect(h.shellOpenPath).not.toHaveBeenCalled();
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("UNC file URL 遵循宿主平台语义，始终不回退到 shell.openExternal", async () => {
    const { listener, options } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    listener({ sender }, "file://server/share/page.html");

    if (process.platform === "win32") {
      await vi.waitFor(() => expect(h.shellOpenPath).toHaveBeenCalledTimes(1));
      expect(h.shellOpenPath).toHaveBeenCalledWith("\\\\server\\share\\page.html");
      expect(options.logger.warn).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(options.logger.warn).toHaveBeenCalledTimes(1));
      expect(h.shellOpenPath).not.toHaveBeenCalled();
    }
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });
});
