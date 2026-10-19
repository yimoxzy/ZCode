import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ zhiliu: false, endpoint: "" }));
const mocks = vi.hoisted(() => ({
  init: vi.fn(async (_config: unknown) => {}),
  useReporter: vi.fn(),
  deviceMid: vi.fn(() => "local-device"),
  crashCapture: vi.fn(() => ({
    rootDir: "test",
    stagingDir: "test/live",
    archiveDir: "test/archive",
  })),
  info: vi.fn(),
  warn: vi.fn(),
}));
const client = vi.hoisted(() => ({ useReporter: mocks.useReporter }));

vi.mock("@arms/rum-electron", () => ({ default: { init: mocks.init, client } }));
vi.mock("../src/main/desktopDeviceMid.js", () => ({ ensureDesktopDeviceMidSync: mocks.deviceMid }));
vi.mock("../src/main/desktopCrashCapture.js", () => ({
  initializeCrashCapture: mocks.crashCapture,
}));
vi.mock("../src/main/desktopNetworkTelemetry.js", () => ({
  ingestArmsApiEventsFromBatch: vi.fn(),
}));
vi.mock("../src/main/desktopRuntimeEnv.js", () => ({
  desktopRuntimeEnv: "development",
  runtimeApplicationName: "织流",
}));
vi.mock("../src/main/logger.js", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: vi.fn() },
}));
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return state.zhiliu;
  },
  get ZCODE_ARMS_RUM_ENDPOINT() {
    return state.endpoint;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.init.mockResolvedValue(undefined);
  state.zhiliu = false;
  state.endpoint = "";
  client.useReporter = mocks.useReporter;
});
afterEach(() => vi.unstubAllGlobals());

describe("optional ARMS bootstrap", () => {
  it.each([false, true])(
    "empty endpoint skips SDK init and keeps crash reporting local, zhiliu=%s",
    async (zhiliu) => {
      state.zhiliu = zhiliu;
      const { armsInitPromise, isArmsTelemetryReady } =
        await import("../src/main/appARMSBootstrap.js");
      await expect(armsInitPromise).resolves.toBeUndefined();
      expect(isArmsTelemetryReady()).toBe(false);
      await import("../src/main/appCrashCaptureBootstrap.js");
      expect(mocks.init).not.toHaveBeenCalled();
      expect(client.useReporter).toBe(mocks.useReporter);
      expect(mocks.deviceMid).not.toHaveBeenCalled();
      expect(mocks.crashCapture).toHaveBeenCalledWith(expect.anything(), false);
    },
  );

  it("织流即使误配上游端点也不安装 SDK、renderer collector 或远端 crash reporter", async () => {
    state.zhiliu = true;
    state.endpoint = "https://upstream.example.test/rum";
    vi.stubGlobal("ArmsEventBridge", { send: vi.fn() });
    const { armsInitPromise } = await import("../src/main/appARMSBootstrap.js");
    await armsInitPromise;
    await import("../src/main/appCrashCaptureBootstrap.js");
    const browser = await import("../src/shared/armsBrowserInit.js");
    expect(browser.initArmsBrowserRumOnce("development")).toBe(false);
    const timer = vi.spyOn(globalThis, "setTimeout");
    browser.scheduleArmsBrowserRumInit("development");
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.crashCapture).toHaveBeenCalledWith(expect.anything(), false);
  });

  it("explicitly enabled upstream builds retain telemetry configuration", async () => {
    state.endpoint = "https://upstream.example.test/rum";
    const { armsInitPromise, isArmsTelemetryReady } =
      await import("../src/main/appARMSBootstrap.js");
    await armsInitPromise;
    expect(isArmsTelemetryReady()).toBe(true);
    await import("../src/main/appCrashCaptureBootstrap.js");
    expect(mocks.init).toHaveBeenCalledWith(
      expect.objectContaining({ enable: true, autoInject: true, endpoint: state.endpoint }),
    );
    expect(mocks.crashCapture).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("SDK rejection does not reject application startup and keeps a readable local error", async () => {
    state.endpoint = "https://upstream.example.test/rum";
    mocks.init.mockRejectedValueOnce(new TypeError("telemetry unavailable"));
    const { armsInitPromise, isArmsTelemetryReady } =
      await import("../src/main/appARMSBootstrap.js");
    await expect(armsInitPromise).resolves.toBeUndefined();
    expect(isArmsTelemetryReady()).toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing without telemetry"),
      { name: "TypeError", message: "telemetry unavailable" },
    );
    expect(mocks.crashCapture).toHaveBeenCalledWith(expect.anything(), false);
  });

  it("readiness stays false while SDK init is pending and repeated reads never reinitialize or mutate SDK", async () => {
    state.endpoint = "https://upstream.example.test/rum";
    let complete: (() => void) | undefined;
    mocks.init.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const bootstrap = await import("../src/main/appARMSBootstrap.js");
    expect(Array.from({ length: 5 }, () => bootstrap.isArmsTelemetryReady())).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    complete?.();
    await bootstrap.armsInitPromise;
    expect(Array.from({ length: 5 }, () => bootstrap.isArmsTelemetryReady())).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.useReporter).not.toHaveBeenCalled();
  });
});
