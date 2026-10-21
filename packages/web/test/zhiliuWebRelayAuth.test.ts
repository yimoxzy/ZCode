import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlEntry, ZhiliuWebRelayAuth } from "../src/web-remote-control/index.js";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

const principal = "11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const otherPrincipal = "11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333";
const relayGrant = "rc_" + "a".repeat(64);
const rotatedGrant = "rc_" + "b".repeat(64);

function grantBody(token = relayGrant, identity = principal) {
  return {
    protocol_version: 1,
    relay_grant: token,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    principal_id: identity,
    desktop_device_id: null,
  };
}

function authFixture(fetcher: typeof fetch = async () => Response.json(grantBody())) {
  const values = new Map([
    ["access_token", "saas-access"],
    ["refresh_token", "saas-refresh"],
  ]);
  const navigate = vi.fn();
  const setItem = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  const auth = new ZhiliuWebRelayAuth({
    origin: "https://zhiliu.example",
    navigate,
    fetcher,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem,
      removeItem: (key) => {
        values.delete(key);
      },
    },
  });
  cleanups.push(() => auth.dispose());
  return { auth, values, setItem, navigate };
}

describe("织流网页 relay 身份边界", () => {
  it("同源现有 Bearer 换内存 rc_；并发请求只签发一次，不写凭据存储", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const h = authFixture(fetcher);
    const first = h.auth.prepareSession(new AbortController().signal);
    const second = h.auth.prepareSession(new AbortController().signal);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://zhiliu.example/api/desktop-relay/terminal-grants");
    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer saas-access", "Content-Type": "application/json" },
    });
    finish(Response.json(grantBody()));
    await Promise.all([first, second]);
    expect(h.auth.getZCodeJwtToken()).toBe(relayGrant);
    expect(h.auth.getSessionIdentity()).toBe(principal);
    expect(h.setItem).not.toHaveBeenCalled();
    expect([...h.values.values()]).not.toContain(relayGrant);
  });

  it.each(["extra", "expired", "identity", "device", "token"])(
    "拒绝非法 %s 授权响应",
    async (kind) => {
      const invalid: Record<string, unknown> = grantBody();
      if (kind === "extra") invalid.upstream_key = "must-not-accept";
      if (kind === "expired") invalid.expires_at = new Date(Date.now() - 1).toISOString();
      if (kind === "identity") invalid.principal_id = "user-only";
      if (kind === "device") invalid.desktop_device_id = "33333333-3333-4333-8333-333333333333";
      if (kind === "token") invalid.relay_grant = "dl_wrong-credential-kind";
      const h = authFixture(async () => Response.json(invalid));
      await expect(h.auth.prepareSession(new AbortController().signal)).rejects.toMatchObject({
        reason: "relay-unavailable",
      });
      expect(h.auth.getZCodeJwtToken()).toBeNull();
    },
  );

  it("到期前刷新同身份凭据并通知原 transport；scope 改变发 identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    let count = 0;
    const h = authFixture(async () =>
      Response.json(
        ++count === 1
          ? grantBody()
          : count === 2
            ? grantBody(rotatedGrant)
            : grantBody(relayGrant, otherPrincipal),
      ),
    );
    const changes = vi.fn();
    h.auth.subscribeCredentialChanged(changes);
    await h.auth.prepareSession(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(count).toBe(2);
    expect(h.auth.getZCodeJwtToken()).toBe(rotatedGrant);
    expect(changes).toHaveBeenLastCalledWith("credential");
    await vi.advanceTimersByTimeAsync(270_000);
    expect(changes).toHaveBeenLastCalledWith("identity");
    expect(h.auth.getSessionIdentity()).toBe(otherPrincipal);
  });

  it("共享签发中的一个调用者取消，不影响其他等待者", async () => {
    let finish!: (response: Response) => void;
    const h = authFixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const cancelled = h.auth.prepareSession(controller.signal);
    const active = h.auth.prepareSession(new AbortController().signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    finish(Response.json(grantBody()));
    await active;
    expect(h.auth.getZCodeJwtToken()).toBe(relayGrant);
  });

  it("退出后迟到签发不恢复 rc_，也不写回已清的 SaaS 身份", async () => {
    let finish!: (response: Response) => void;
    const h = authFixture((url) =>
      String(url).endsWith("/logout")
        ? Promise.resolve(Response.json({ ok: true }))
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const pending = h.auth.prepareSession(new AbortController().signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await h.auth.logout();
    finish(Response.json(grantBody()));
    await rejected;
    expect(h.auth.getZCodeJwtToken()).toBeNull();
    expect(h.values.has("access_token")).toBe(false);
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it("旧账号签发迟到不能清掉或覆盖新账号的 sessionStorage", async () => {
    let finish!: (response: Response) => void;
    const h = authFixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.auth.prepareSession(new AbortController().signal);
    h.values.set("access_token", "new-account-access");
    h.values.set("refresh_token", "new-account-refresh");
    finish(Response.json(grantBody()));
    await expect(pending).rejects.toMatchObject({ reason: "auth-required" });
    expect(h.values.get("access_token")).toBe("new-account-access");
    expect(h.values.get("refresh_token")).toBe("new-account-refresh");
    expect(h.auth.getZCodeJwtToken()).toBeNull();
  });

  it("access_token 401 按现有 SaaS 刷新一次后重签，rc_始终不持久化", async () => {
    let grants = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/refresh"))
        return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh" });
      return ++grants === 1 ? new Response("", { status: 401 }) : Response.json(grantBody());
    });
    const h = authFixture(fetcher);
    await h.auth.prepareSession(new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      body: JSON.stringify({ refresh_token: "saas-refresh" }),
    });
    expect(fetcher.mock.calls[2]![1]).toMatchObject({
      headers: { Authorization: "Bearer rotated-access" },
    });
    expect(h.values.get("access_token")).toBe("rotated-access");
    expect(h.auth.getZCodeJwtToken()).toBe(relayGrant);
    expect(h.setItem.mock.calls.some(([, value]) => value.startsWith("rc_"))).toBe(false);
  });

  it("根会话刷新被拒绝才清原身份；错误不泄漏响应正文", async () => {
    const h = authFixture(async () => new Response("private upstream detail", { status: 401 }));
    await expect(h.auth.prepareSession(new AbortController().signal)).rejects.toMatchObject({
      message: "auth-required",
    });
    expect(h.values.has("access_token")).toBe(false);
  });

  it("登录返回仅允许同源 remote/v4，拒绝外站回跳和官方 OAuth", () => {
    const h = authFixture();
    h.auth.startLogin({ appReturnTo: "https://other.example/remote/v4?token=do-not-forward" });
    expect(h.navigate).toHaveBeenCalledWith("https://zhiliu.example/?next=%2Fremote%2Fv4");
    h.auth.startLogin({ appReturnTo: "https://zhiliu.example/remote/v4?sid=device" });
    expect(h.navigate).toHaveBeenLastCalledWith(
      "https://zhiliu.example/?next=%2Fremote%2Fv4%3Fsid%3Ddevice",
    );
    h.auth.startLogin({
      appReturnTo: "https://zhiliu.example/remote/v4?sid=device&token=private&access_token=private",
    });
    expect(h.navigate).toHaveBeenLastCalledWith(
      "https://zhiliu.example/?next=%2Fremote%2Fv4%3Fsid%3Ddevice",
    );
  });

  it("relay 短期授权 401 仅重签一次，根会话仍有效时不退出 SaaS", async () => {
    let issued = 0;
    const h = authFixture(async () =>
      Response.json(grantBody(++issued === 1 ? relayGrant : rotatedGrant)),
    );
    const connect = vi.fn();
    const logout = vi.spyOn(h.auth, "logout");
    const token = vi
      .fn()
      .mockRejectedValueOnce(new WebRemoteControlV2ConnectionError("auth-required"))
      .mockResolvedValueOnce("one-use");
    const entry = new WebRemoteControlEntry({
      auth: h.auth,
      getHref: () => "https://zhiliu.example/remote/v4?sid=desktop",
      replaceHref: vi.fn(),
      storage: { getItem: () => null, setItem: vi.fn() },
      locale: "zh-CN",
      devices: async () => [],
      subscribeVisible: () => () => {},
      token,
      connect,
      onView: vi.fn(),
    });
    cleanups.push(() => entry.dispose());
    await entry.start();
    await expect(connect.mock.calls[0]![0].getToken(new AbortController().signal)).resolves.toBe(
      "one-use",
    );
    expect(issued).toBe(2);
    expect(token.mock.calls.map((call) => call[0])).toEqual([relayGrant, rotatedGrant]);
    expect(logout).not.toHaveBeenCalled();
    expect(h.values.get("access_token")).toBe("saas-access");
  });

  it("Entry 同身份刷新通知原连接，身份变化撤销旧 connection 后重新 admission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    let count = 0;
    const h = authFixture(async () =>
      Response.json(
        ++count === 1
          ? grantBody()
          : count === 2
            ? grantBody(rotatedGrant)
            : grantBody(relayGrant, otherPrincipal),
      ),
    );
    const connect = vi.fn();
    const entry = new WebRemoteControlEntry({
      auth: h.auth,
      getHref: () => "https://zhiliu.example/remote/v4?sid=desktop",
      replaceHref: vi.fn(),
      storage: { getItem: () => null, setItem: vi.fn() },
      locale: "zh-CN",
      devices: async () => [],
      subscribeVisible: () => () => {},
      token: async () => "one-use",
      connect,
      onView: vi.fn(),
    });
    cleanups.push(() => entry.dispose());
    await entry.start();
    const original = connect.mock.calls[0]![0];
    const rotated = vi.fn();
    original.subscribeCredentialChanged(rotated);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(rotated).toHaveBeenCalledOnce();
    expect(original.signal.aborted).toBe(false);
    expect(connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(original.signal.aborted).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
