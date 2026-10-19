import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialog, type UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { createZhiliuComputerConnection } from "../src/main/zhiliuComputerConnection.js";
import type { StoredZhiliuHost } from "../src/main/zhiliuHostAuthorization.js";

const harness = vi.hoisted(() => ({
  stored: null as StoredZhiliuHost | null,
  read: vi.fn<(origin: string) => Promise<StoredZhiliuHost | null>>(),
  write: vi.fn<(record: StoredZhiliuHost) => Promise<void>>(),
  remove: vi.fn<(origin: string) => Promise<void>>(),
  exchange: vi.fn<() => Promise<StoredZhiliuHost | null>>(),
  begin: vi.fn(),
  openCloud: vi.fn(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Port extends EventEmitter {
    postMessage = vi.fn();
    start = vi.fn();
    close = vi.fn(() => this.emit("close"));
  }
  return {
    app: { getPath: vi.fn(() => "/test-user-data") },
    safeStorage: {},
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    MessageChannelMain: class {
      port1 = new Port();
      port2 = new Port();
    },
  };
});
vi.mock("../src/main/zhiliuHostAuthorization.js", () => ({
  beginZhiliuHostAuthorization: harness.begin,
  ZhiliuHostStore: class {
    read = harness.read;
    write = harness.write;
    remove = harness.remove;
  },
}));
vi.mock("../src/main/zhiliuCloudWindow.js", () => ({
  openZhiliuCloudWindow: harness.openCloud,
}));
vi.mock("../src/main/zhiliuNativeReview.js", () => ({
  showZhiliuNativeReview: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const origin = "https://platform.example.test";
const record = (token = "host-token-for-test-only"): StoredZhiliuHost => ({
  origin,
  privateKey: "private-host-key-for-test-only",
  credential: {
    host_token: token,
    device_id: "bc8c4237-5b92-4563-904e-d95cc018cb31",
    user_id: "089e7630-3844-49b7-9034-ddab7a4df2f9",
    space_id: "e60165ca-10d0-4cc8-bde5-7693461ba044",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
});
function controller() {
  const host = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  return createZhiliuComputerConnection({
    cloudUrl: () => origin,
    resolveHost: () => host as unknown as UtilityProcess,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.stored = null;
  harness.read.mockImplementation(async () => harness.stored);
  harness.write.mockImplementation(async (value) => {
    harness.stored = value;
  });
  harness.remove.mockImplementation(async () => {
    harness.stored = null;
  });
  harness.exchange.mockResolvedValue(record());
  harness.begin.mockResolvedValue({
    authorizationId: "26c84121-1d9f-4f46-91a5-20688ee3a011",
    userCode: "PAIR-2026",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    exchange: harness.exchange,
  });
  harness.openCloud.mockResolvedValue(undefined);
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null)));
});
afterEach(() => vi.unstubAllGlobals());

describe("织流 Main 电脑连接凭据代次", () => {
  it("serializes disconnect after an in-flight save and removes credentials before network revoke", async () => {
    const saving = deferred<void>();
    const saveStarted = deferred<void>();
    harness.write.mockImplementation(async (value) => {
      saveStarted.resolve();
      await saving.promise;
      harness.stored = value;
    });
    vi.mocked(fetch).mockImplementation(async () => {
      expect(harness.stored).toBeNull();
      return new Response(null);
    });
    const connection = controller();
    const connecting = connection.connect();
    await saveStarted.promise;
    const disconnecting = connection.disconnect();
    saving.resolve();
    await Promise.all([connecting, disconnecting]);
    expect(harness.stored).toBeNull();
    expect(harness.remove).toHaveBeenCalledExactlyOnceWith(origin);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${origin}/api/desktop-host/devices/${record().credential.device_id}/disconnect`,
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it("does not save an exchange result arriving after disconnect", async () => {
    const exchange = deferred<StoredZhiliuHost | null>();
    const started = deferred<void>();
    harness.exchange.mockImplementation(() => {
      started.resolve();
      return exchange.promise;
    });
    const connection = controller();
    const connecting = connection.connect();
    await started.promise;
    await connection.disconnect();
    exchange.resolve(record());
    await connecting;
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.stored).toBeNull();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it("checks the generation inside a save that was queued immediately before disconnect", async () => {
    const exchange = deferred<StoredZhiliuHost | null>();
    const started = deferred<void>();
    const disconnected = deferred<void>();
    harness.exchange.mockImplementation(() => {
      started.resolve();
      return exchange.promise;
    });
    const connection = controller();
    const connecting = connection.connect();
    await started.promise;
    exchange.resolve(record());
    // connect 的 continuation 先接纳保存，再由下一 microtask 断开；磁盘队列尚未执行。
    queueMicrotask(() => {
      void connection.disconnect().then(disconnected.resolve, disconnected.reject);
    });
    await Promise.all([connecting, disconnected.promise]);
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.stored).toBeNull();
  });

  it("continues queued credential cleanup after an old read fails", async () => {
    const reading = deferred<StoredZhiliuHost | null>();
    const started = deferred<void>();
    harness.read.mockImplementationOnce(() => {
      started.resolve();
      return reading.promise;
    });
    const connection = controller();
    const connecting = connection.connect();
    await started.promise;
    const disconnecting = connection.disconnect();
    reading.reject(new Error("late storage read failure"));
    await Promise.all([connecting, disconnecting]);
    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(harness.remove).toHaveBeenCalledExactlyOnceWith(origin);
    expect(harness.stored).toBeNull();
    expect(
      vi.mocked(dialog.showMessageBox).mock.calls.some(([options]) => options.type === "error"),
    ).toBe(false);
  });

  it("removes unreadable local credentials on disconnect and directs remote revocation to the web", async () => {
    harness.stored = record();
    harness.read.mockRejectedValueOnce(new Error("unreadable credential storage"));
    const connection = controller();
    await connection.disconnect();
    expect(harness.remove).toHaveBeenCalledExactlyOnceWith(origin);
    expect(harness.stored).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await connection.status();
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "本机账号授权已移除；可在网页撤销对应设备" }),
    );
  });

  it("does not let a stale exchange error pause or show an error over the disconnected generation", async () => {
    const exchange = deferred<StoredZhiliuHost | null>();
    const started = deferred<void>();
    harness.exchange.mockImplementation(() => {
      started.resolve();
      return exchange.promise;
    });
    const connection = controller();
    const connecting = connection.connect();
    await started.promise;
    await connection.disconnect();
    exchange.reject(new Error("late authorization failure"));
    await connecting;
    expect(
      vi.mocked(dialog.showMessageBox).mock.calls.some(([options]) => options.type === "error"),
    ).toBe(false);
    await connection.status();
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "本机账号授权已移除；可在网页撤销对应设备" }),
    );
  });

  it("does not let a late network revocation overwrite a newer live connection", async () => {
    harness.stored = record("old-test-host-token");
    const network = deferred<Response>();
    const started = deferred<void>();
    vi.mocked(fetch).mockImplementation(() => {
      started.resolve();
      return network.promise;
    });
    const connection = controller();
    const disconnecting = connection.disconnect();
    await started.promise;
    expect(harness.stored).toBeNull();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["/authorized-workspace"],
    });
    await connection.connect();
    network.resolve(new Response(null));
    await disconnecting;
    expect(harness.stored?.credential.host_token).toBe("host-token-for-test-only");
    await connection.status();
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "正在连接织流电脑服务" }),
    );
    connection.pause();
  });
});
