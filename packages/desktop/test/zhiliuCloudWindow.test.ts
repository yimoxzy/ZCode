import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow, session } from "electron";
import { openZhiliuCloudWindow } from "../src/main/zhiliuCloudWindow.js";

const harness = vi.hoisted(() => ({ failNextLoad: false }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const cloudSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
  });
  class FakeWindow extends EventEmitter {
    static instances: FakeWindow[] = [];
    options: Record<string, unknown>;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      id: FakeWindow.instances.length + 1,
      setWindowOpenHandler: vi.fn(),
    });
    loadURL = vi.fn(async () => {
      if (harness.failNextLoad) {
        harness.failNextLoad = false;
        throw new Error("load failed: https://eight.example.com/?token=private");
      }
    });
    removeMenu = vi.fn();
    isMinimized = vi.fn().mockReturnValue(false);
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      FakeWindow.instances.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return { BrowserWindow: FakeWindow, session: { fromPartition: vi.fn(() => cloudSession) } };
});

type FakeWindow = BrowserWindow & {
  options: { webPreferences: Record<string, unknown> };
};
const fakeSession = () => session.fromPartition("test");
const windows = () => (BrowserWindow as unknown as { instances: FakeWindow[] }).instances;

beforeEach(() => {
  for (const win of windows()) if (!win.isDestroyed()) win.destroy();
  harness.failNextLoad = false;
  vi.clearAllMocks();
});
afterEach(() => {
  for (const win of windows()) if (!win.isDestroyed()) win.destroy();
});

describe("织流云窗口生命周期与事件边界", () => {
  it("云窗口没有本地权限，登录和数据不通过主 React renderer", async () => {
    const win = await openZhiliuCloudWindow({ cloudUrl: "https://one.example.com" });
    const preferences = (win as FakeWindow).options.webPreferences;
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(preferences).not.toHaveProperty("preload");
    expect(fakeSession().setPermissionRequestHandler).toHaveBeenCalled();
    const denyPermission = vi.mocked(fakeSession().setPermissionRequestHandler).mock.calls[0]?.[0];
    const callback = vi.fn();
    denyPermission?.(win.webContents, "media", callback, {} as never);
    expect(callback).toHaveBeenCalledWith(false);
    expect(win.loadURL).toHaveBeenCalledWith("https://one.example.com/#/agent");
  });

  it("重复打开保持当前登录和草稿，不重新加载；最小化后恢复", async () => {
    const first = await openZhiliuCloudWindow({ cloudUrl: "https://two.example.com" });
    vi.mocked(first.isMinimized).mockReturnValue(true);
    const second = await openZhiliuCloudWindow({ cloudUrl: "https://two.example.com/#/knowledge" });
    expect(second).toBe(first);
    expect(first.loadURL).toHaveBeenCalledTimes(1);
    expect(first.restore).toHaveBeenCalled();
  });

  it("切换服务关闭旧窗口，不共用浏览器身份 partition", async () => {
    const first = await openZhiliuCloudWindow({ cloudUrl: "https://three.example.com" });
    const second = await openZhiliuCloudWindow({ cloudUrl: "https://four.example.com" });
    expect(first.isDestroyed()).toBe(true);
    expect((second as FakeWindow).options.webPreferences.partition).not.toBe(
      (first as FakeWindow).options.webPreferences.partition,
    );
  });

  it("拒绝弹窗、外源导航、重定向和嵌套 webview", async () => {
    const win = await openZhiliuCloudWindow({ cloudUrl: "https://five.example.com" });
    const opener = vi.mocked(win.webContents.setWindowOpenHandler).mock.calls[0]?.[0];
    expect(opener?.({ url: "https://evil.test" } as never)).toEqual({ action: "deny" });
    for (const name of ["will-navigate", "will-redirect"]) {
      const event = { preventDefault: vi.fn() };
      win.webContents.emit(name, event, "file:///C:/private");
      expect(event.preventDefault).toHaveBeenCalled();
    }
    const frameEvent = { preventDefault: vi.fn(), url: "https://evil.test", isMainFrame: false };
    win.webContents.emit("will-frame-navigate", frameEvent);
    expect(frameEvent.preventDefault).toHaveBeenCalled();
    const attachEvent = { preventDefault: vi.fn() };
    win.webContents.emit("will-attach-webview", attachEvent);
    expect(attachEvent.preventDefault).toHaveBeenCalled();
  });

  it("只接受自身同源下载，始终使用用户选择的保存位置", async () => {
    const win = await openZhiliuCloudWindow({ cloudUrl: "https://six.example.com" });
    const event = { preventDefault: vi.fn() };
    const item = {
      getURL: () => "blob:https://six.example.com/file",
      getFilename: () => "../../result.pptx",
      setSaveDialogOptions: vi.fn(),
      setSavePath: vi.fn(),
    };
    fakeSession().emit("will-download", event, item, win.webContents);
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      title: "保存织流文件",
      defaultPath: "result.pptx",
    });
    expect(item.setSavePath).not.toHaveBeenCalled();
    fakeSession().emit("will-download", event, item, { id: -1 });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    item.getURL = () => "https://evil.test/executable";
    fakeSession().emit("will-download", event, item, win.webContents);
    expect(event.preventDefault).toHaveBeenCalled();
    win.destroy();
    expect(fakeSession().listenerCount("will-download")).toBe(0);
  });

  it("首次加载失败后可重新打开，抛错不带页面地址参数", async () => {
    harness.failNextLoad = true;
    await expect(openZhiliuCloudWindow({ cloudUrl: "https://eight.example.com" })).rejects.toThrow(
      "无法打开织流云 Agent",
    );
    expect(windows().at(-1)?.isDestroyed()).toBe(true);
    const retry = await openZhiliuCloudWindow({ cloudUrl: "https://eight.example.com" });
    expect(retry.isDestroyed()).toBe(false);
  });
});
