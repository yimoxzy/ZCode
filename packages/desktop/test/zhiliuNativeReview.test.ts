import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow, session } from "electron";
import { showZhiliuNativeReview } from "../src/main/zhiliuNativeReview.js";

const harness = vi.hoisted(() => ({ failLoad: false }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const nativeSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  class FakeWindow extends EventEmitter {
    static instances: FakeWindow[] = [];
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    loadURL = vi.fn(async (_url: string) => {
      if (harness.failLoad) throw new Error("load failed");
    });
    removeMenu = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    constructor(readonly options: Record<string, unknown>) {
      super();
      FakeWindow.instances.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return { BrowserWindow: FakeWindow, session: { fromPartition: vi.fn(() => nativeSession) } };
});

type FakeWindow = BrowserWindow & {
  options: { title: string; webPreferences: Record<string, unknown> };
};
const windows = () => (BrowserWindow as unknown as { instances: FakeWindow[] }).instances;
const latest = () => windows().at(-1)!;
const html = (window: FakeWindow) =>
  decodeURIComponent(
    (vi.mocked(window.loadURL).mock.calls[0]![0] as string).split(",").slice(1).join(","),
  );
const links = (window: FakeWindow) =>
  [...html(window).matchAll(/href="([^"]+)"/gu)].map((match) => match[1]!);
const navigate = (window: FakeWindow, url: string) => {
  const event = { preventDefault: vi.fn() };
  window.webContents.emit("will-navigate", event, url);
  expect(event.preventDefault).toHaveBeenCalledOnce();
};

beforeEach(() => {
  vi.useFakeTimers();
  harness.failLoad = false;
  vi.clearAllMocks();
});
afterEach(() => {
  for (const window of windows()) if (!window.isDestroyed()) window.destroy();
  vi.useRealTimers();
});

describe("织流本机操作与结果确认", () => {
  it("creates an isolated no-Node/no-preload window and denies browser permissions", async () => {
    const review = showZhiliuNativeReview("operation", "写入文件确认", "完整变更内容");
    const window = latest();
    const preferences = window.options.webPreferences;
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    });
    expect(preferences).not.toHaveProperty("preload");
    expect(preferences.partition).toMatch(/^zhiliu-review-[a-f0-9-]{36}$/u);
    const nativeSession = session.fromPartition(preferences.partition as string);
    const permission = vi.mocked(nativeSession.setPermissionRequestHandler).mock.calls[0]![0];
    const callback = vi.fn();
    permission(window.webContents, "media", callback, {} as never);
    expect(callback).toHaveBeenCalledWith(false);
    expect(
      vi
        .mocked(nativeSession.setPermissionCheckHandler)
        .mock.calls[0]![0](window.webContents, "media", "https://evil.test", {} as never),
    ).toBe(false);
    const open = vi.mocked(window.webContents.setWindowOpenHandler).mock.calls[0]![0];
    expect(open({ url: "https://evil.test" } as never)).toEqual({ action: "deny" });
    await Promise.resolve();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    review.close();
    await expect(review.answer).resolves.toBe("reject");
  });

  it("escapes injected title/detail as text with a strict CSP and no script/preload", async () => {
    const title = `</title><script>alert("x")</script>`;
    const detail = `<img src=x onerror="fetch('https://evil.test')"> & </pre><a href="https://evil.test/approve">允许</a>`;
    const review = showZhiliuNativeReview("operation", title, detail);
    const window = latest(),
      content = html(window);
    expect(content).toContain(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    expect(content).not.toContain("<script>");
    expect(content).not.toContain("<img");
    expect(content).not.toContain('<a href="https://evil.test');
    expect(content).toContain("&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(content).toContain(
      "&lt;img src=x onerror=&quot;fetch(&#39;https://evil.test&#39;)&quot;&gt;",
    );
    expect(links(window)).toHaveLength(2);
    review.close();
    await expect(review.answer).resolves.toBe("reject");
  });

  it("accepts only the exact current nonce navigation and blocks URL variants", async () => {
    const review = showZhiliuNativeReview("operation", "approve", "detail");
    const window = latest(),
      approve = links(window).find((url) => url.endsWith("/approve"))!;
    let settled = false;
    void review.answer.then(() => {
      settled = true;
    });
    for (const url of [
      "https://zhiliu.invalid/review/wrong-nonce/approve",
      `${approve}?answer=approve`,
      `${approve}#approve`,
      `${approve}/`,
      approve.replace("https:", "http:"),
      approve.replace("zhiliu.invalid", "zhiliu.invalid.evil.test"),
      approve.replace("/approve", "/%61pprove"),
      "javascript:approve()",
    ])
      navigate(window, url);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(window.isDestroyed()).toBe(false);
    navigate(window, approve);
    await expect(review.answer).resolves.toBe("approve");
    expect(window.isDestroyed()).toBe(true);
  });

  it("keeps review nonces and browser partitions independent", async () => {
    const first = showZhiliuNativeReview("operation", "first", "first");
    const firstWindow = latest(),
      firstApprove = links(firstWindow)[1]!;
    const second = showZhiliuNativeReview("operation", "second", "second");
    const secondWindow = latest();
    expect(secondWindow.options.webPreferences.partition).not.toBe(
      firstWindow.options.webPreferences.partition,
    );
    navigate(secondWindow, firstApprove);
    expect(secondWindow.isDestroyed()).toBe(false);
    first.close();
    second.close();
    await expect(first.answer).resolves.toBe("reject");
    await expect(second.answer).resolves.toBe("reject");
  });

  it.each(["will-redirect", "will-attach-webview"])(
    "blocks %s without resolving approval",
    async (eventName) => {
      const review = showZhiliuNativeReview("operation", "review", "detail");
      const window = latest(),
        event = { preventDefault: vi.fn() };
      window.webContents.emit(eventName, event, links(window)[1]);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(window.isDestroyed()).toBe(false);
      review.close();
      await expect(review.answer).resolves.toBe("reject");
    },
  );

  it.each(["operation", "result"] as const)(
    "uses the safe default when %s is canceled, closed or timed out",
    async (kind) => {
      const fallback = kind === "operation" ? "reject" : "summary";
      for (const action of ["cancel", "closed", "timeout"] as const) {
        const review = showZhiliuNativeReview(kind, "review", "detail");
        if (action === "cancel") review.close();
        if (action === "closed") latest().destroy();
        if (action === "timeout") await vi.advanceTimersByTimeAsync(180000);
        await expect(review.answer).resolves.toBe(fallback);
        expect(latest().isDestroyed()).toBe(true);
      }
    },
  );

  it("requires explicit content choice before sharing complete results", async () => {
    const review = showZhiliuNativeReview("result", "执行结果", "private content");
    const window = latest(),
      resultLinks = links(window);
    expect(resultLinks.map((url) => url.split("/").at(-1))).toEqual(["summary", "content"]);
    navigate(window, resultLinks[0]!.replace("/summary", "/approve"));
    expect(window.isDestroyed()).toBe(false);
    navigate(window, resultLinks[1]!);
    await expect(review.answer).resolves.toBe("content");
    review.close();
    await expect(review.answer).resolves.toBe("content");
  });

  it.each(["operation", "result"] as const)(
    "fails closed when the %s preview cannot load",
    async (kind) => {
      harness.failLoad = true;
      const review = showZhiliuNativeReview(kind, "review", "detail");
      await expect(review.answer).resolves.toBe(kind === "operation" ? "reject" : "summary");
      expect(latest().show).not.toHaveBeenCalled();
      expect(latest().isDestroyed()).toBe(true);
    },
  );
});
