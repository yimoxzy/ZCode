import { describe, expect, it, vi } from "vitest";
import { createZhiliuAccountAuth } from "../src/main/zhiliuAccountAuth.js";
import {
  createZhiliuAccountDeviceIdentity,
  type StoredZhiliuAccount,
} from "../src/main/zhiliuAccountAuthorization.js";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/test-data") },
  safeStorage: {},
  dialog: { showMessageBox: vi.fn() },
}));

const origin = "https://platform.example.test";
const authorizationId = "26c84121-1d9f-4f46-91a5-20688ee3a011";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function fixture(restored = false) {
  let time = Date.now();
  const credential = {
    login_token: "dl_test-account-token-for-tests-only",
    device_id: "bc8c4237-5b92-4563-904e-d95cc018cb31",
    user_id: "089e7630-3844-49b7-9034-ddab7a4df2f9",
    space_id: "e60165ca-10d0-4cc8-bde5-7693461ba044",
    expires_at: new Date(time + 3600000).toISOString(),
    user: {
      id: "089e7630-3844-49b7-9034-ddab7a4df2f9",
      email: "test@example.test",
      nickname: "测试",
      is_admin: false,
    },
    space: {
      id: "e60165ca-10d0-4cc8-bde5-7693461ba044",
      name: "测试空间",
      space_type: "personal",
      role: "owner",
    },
  };
  const record: StoredZhiliuAccount = {
    origin,
    ...createZhiliuAccountDeviceIdentity(),
    credential,
  };
  let saved: StoredZhiliuAccount | null = restored ? record : null;
  const calls: string[] = [];
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const http = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith("/authorizations"))
      return response({
        authorization_id: authorizationId,
        device_code: "test-device-code-for-tests-only",
        user_code: "TEST-2026",
        expires_at: new Date(time + 600000).toISOString(),
        poll_interval_seconds: 3,
        verification_path: `/#/desktop-authorize?authorize=${authorizationId}`,
      });
    if (path.endsWith("/exchange")) return response(credential);
    if (path.endsWith("/session")) {
      const { login_token: _ignored, ...session } = credential;
      return response(session);
    }
    if (path.endsWith("/bootstrap"))
      return response({
        ticket: "bootstrap-test-ticket-for-tests-only",
        expires_at: new Date(time + 60000).toISOString(),
      });
    if (path.endsWith("/logout")) return response(null);
    throw new Error("Unexpected URL");
  });
  const store = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (value: StoredZhiliuAccount) => {
      saved = value;
    }),
    remove: vi.fn(async () => {
      saved = null;
    }),
  };
  const options = {
    cloudUrl: () => origin,
    http,
    store,
    now: () => time,
    openExternal: vi.fn(async (_url: string) => undefined),
    pauseComputer: vi.fn(() => undefined),
    disconnectComputer: vi.fn(async () => undefined),
    clearCloudSession: vi.fn(async (_origin: string) => undefined),
    openCloudSession: vi.fn(async (_ticket: string, _origin: string) => undefined),
    showMessageBox: vi.fn(async (value: { type?: string }) => ({
      response: value.type === "warning" ? 1 : 0,
    })),
    wait: vi.fn(async (milliseconds: number) => {
      time += milliseconds;
    }),
  };
  return {
    auth: createZhiliuAccountAuth(options),
    options,
    http,
    store,
    record,
    calls,
    response,
    saved: () => saved,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

describe("织流 Main 浏览器账号所有者", () => {
  it("logs in through the system browser without starting a directory connection or exposing secrets to UI", async () => {
    const h = fixture();
    const result = await h.auth.login();
    expect(result.phase).toBe("authenticated");
    expect(h.options.openExternal).toHaveBeenCalledWith(
      `${origin}/#/desktop-authorize?authorize=${authorizationId}`,
    );
    expect(h.options.pauseComputer).not.toHaveBeenCalled();
    expect(h.options.disconnectComputer).not.toHaveBeenCalled();
    expect(h.options.openCloudSession).not.toHaveBeenCalled();
    expect(JSON.stringify(h.auth.status())).not.toContain("dl_");
    expect(JSON.stringify(h.auth.status())).not.toContain("PRIVATE KEY");
    expect(h.saved()?.publicKey).toBeTruthy();
    expect((await h.auth.getDeviceIdentity())?.privateKey).toBe(h.saved()?.privateKey);
  });
  it("shares one pending login, reopens the same approval page and never creates a second request", async () => {
    const h = fixture(),
      exchange = deferred<Response>();
    const original = h.http.getMockImplementation()!;
    h.http.mockImplementation((url, init) =>
      String(url).endsWith("/exchange") ? exchange.promise : original(url, init),
    );
    const first = h.auth.login();
    await vi.waitFor(() => expect(h.auth.status().userCode).toBe("TEST-2026"));
    const second = h.auth.login();
    expect(second).toBe(first);
    expect(h.calls.filter((url) => url.endsWith("/authorizations"))).toHaveLength(1);
    expect(h.options.openExternal).toHaveBeenCalledTimes(2);
    exchange.resolve(h.response(h.record.credential));
    await expect(first).resolves.toMatchObject({ phase: "authenticated" });
  });
  it("cancels login while initial credential restore is pending before opening a browser", async () => {
    const h = fixture(),
      restoring = deferred<StoredZhiliuAccount | null>();
    h.store.read.mockImplementationOnce(() => restoring.promise);
    const login = h.auth.login();
    h.auth.cancelLogin();
    restoring.resolve(null);
    await expect(login).resolves.toMatchObject({ phase: "logged_out" });
    expect(h.options.openExternal).not.toHaveBeenCalled();
    expect(h.http).not.toHaveBeenCalled();
  });
  it("restores through a live session check, caches status for 60 seconds, and rechecks before bootstrap", async () => {
    const h = fixture(true);
    expect(h.auth.status().phase).toBe("logged_out");
    await expect(h.auth.getStatus()).resolves.toMatchObject({ phase: "authenticated" });
    await h.auth.getStatus();
    expect(h.calls.filter((url) => url.endsWith("/session"))).toHaveLength(1);
    await expect(h.auth.authorizeCloud()).resolves.toBe(true);
    expect(h.calls.filter((url) => url.endsWith("/session"))).toHaveLength(2);
    expect(h.options.openCloudSession).toHaveBeenCalledWith(
      "bootstrap-test-ticket-for-tests-only",
      origin,
    );
    h.advance(60001);
    await h.auth.getStatus();
    expect(h.calls.filter((url) => url.endsWith("/session"))).toHaveLength(3);
  });
  it("rejects stale stored sessions and clears the tool connection without deadlocking cloud authorization", async () => {
    const h = fixture(true),
      original = h.http.getMockImplementation()!;
    h.http.mockImplementation((url, init) =>
      String(url).endsWith("/session")
        ? Promise.resolve(h.response({ detail: "revoked" }, 401))
        : original(url, init),
    );
    await expect(h.auth.authorizeCloud()).resolves.toBe(false);
    expect(h.saved()).toBeNull();
    expect(h.options.pauseComputer).toHaveBeenCalledOnce();
    expect(h.options.clearCloudSession).toHaveBeenCalledWith(origin);
    expect(h.options.openCloudSession).not.toHaveBeenCalled();
  });
  it("waits for the entire invalidation cleanup before authorizing, saving or opening a replacement login", async () => {
    const h = fixture(true),
      disconnected = deferred<void>(),
      cleared = deferred<void>();
    const original = h.http.getMockImplementation()!;
    let rejectOldSession = true;
    h.http.mockImplementation((url, init) => {
      if (String(url).endsWith("/session") && rejectOldSession) {
        rejectOldSession = false;
        return Promise.resolve(h.response({ detail: "revoked" }, 401));
      }
      return original(url, init);
    });
    h.options.disconnectComputer.mockImplementationOnce(() => disconnected.promise);
    h.options.clearCloudSession.mockImplementationOnce(() => cleared.promise);
    const invalidation = h.auth.getStatus();
    await vi.waitFor(() => expect(h.options.disconnectComputer).toHaveBeenCalled());
    const login = h.auth.login();
    await expect(h.auth.authorizeCloud()).resolves.toBe(false);
    expect(h.calls.some((url) => url.endsWith("/authorizations"))).toBe(false);
    expect(h.store.write).not.toHaveBeenCalled();
    expect(h.options.openExternal).not.toHaveBeenCalled();
    disconnected.resolve();
    await vi.waitFor(() => expect(h.options.clearCloudSession).toHaveBeenCalled());
    expect(h.calls.some((url) => url.endsWith("/authorizations"))).toBe(false);
    expect(h.store.write).not.toHaveBeenCalled();
    expect(h.options.openCloudSession).not.toHaveBeenCalled();
    cleared.resolve();
    await invalidation;
    await expect(login).resolves.toMatchObject({ phase: "authenticated" });
    expect(h.saved()).not.toBeNull();
    await expect(h.auth.authorizeCloud()).resolves.toBe(true);
    expect(h.options.openCloudSession).toHaveBeenCalledOnce();
    expect(h.auth.status().phase).toBe("authenticated");
  });
  it("cancels a login waiting on invalidation cleanup and permits a later explicit retry", async () => {
    const h = fixture(true),
      disconnected = deferred<void>();
    const original = h.http.getMockImplementation()!;
    let rejectOldSession = true;
    h.http.mockImplementation((url, init) => {
      if (String(url).endsWith("/session") && rejectOldSession) {
        rejectOldSession = false;
        return Promise.resolve(h.response({ detail: "revoked" }, 401));
      }
      return original(url, init);
    });
    h.options.disconnectComputer.mockImplementationOnce(() => disconnected.promise);
    const invalidation = h.auth.getStatus();
    await vi.waitFor(() => expect(h.options.disconnectComputer).toHaveBeenCalled());
    const cancelledLogin = h.auth.login();
    h.auth.cancelLogin();
    disconnected.resolve();
    await invalidation;
    await expect(cancelledLogin).resolves.toMatchObject({ phase: "logged_out" });
    expect(h.calls.some((url) => url.endsWith("/authorizations"))).toBe(false);
    expect(h.store.write).not.toHaveBeenCalled();
    await expect(h.auth.login()).resolves.toMatchObject({ phase: "authenticated" });
    await expect(h.auth.authorizeCloud()).resolves.toBe(true);
  });
  it("does not authorize cloud or device tools while offline and preserves encrypted credentials for retry", async () => {
    const h = fixture(true);
    h.http.mockRejectedValue(new TypeError("network unavailable"));
    await expect(h.auth.getStatus()).resolves.toMatchObject({ phase: "unavailable" });
    await expect(h.auth.getDeviceIdentity()).resolves.toBeNull();
    await expect(h.auth.authorizeCloud()).resolves.toBe(false);
    expect(h.saved()).toBe(h.record);
  });
  it("defaults logout confirmation to cancel and leaves all ownership unchanged when canceled", async () => {
    const h = fixture(true);
    await h.auth.getStatus();
    h.options.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(h.auth.logout()).resolves.toEqual({ confirmed: false, remoteRevoked: false });
    expect(h.options.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ defaultId: 0, cancelId: 0 }),
    );
    expect(h.options.pauseComputer).not.toHaveBeenCalled();
    expect(h.saved()).toBe(h.record);
    expect(h.auth.status().phase).toBe("authenticated");
  });
  it("clears local account, Host and cloud session even when remote revocation is offline", async () => {
    const h = fixture(true),
      original = h.http.getMockImplementation()!;
    await h.auth.getStatus();
    h.http.mockImplementation((url, init) =>
      String(url).endsWith("/logout")
        ? Promise.reject(new TypeError("network unavailable"))
        : original(url, init),
    );
    await expect(h.auth.logout()).resolves.toEqual({ confirmed: true, remoteRevoked: false });
    expect(h.saved()).toBeNull();
    expect(h.options.pauseComputer).toHaveBeenCalledOnce();
    expect(h.options.disconnectComputer).toHaveBeenCalledOnce();
    expect(h.options.clearCloudSession).toHaveBeenCalledWith(origin);
    expect(h.auth.status()).toMatchObject({
      phase: "logged_out",
      message: expect.stringContaining("远端撤销未确认"),
    });
  });
  it("revokes a late exchanged grant after logout without saving or restoring account", async () => {
    const h = fixture(),
      exchange = deferred<Response>(),
      original = h.http.getMockImplementation()!;
    h.http.mockImplementation((url, init) =>
      String(url).endsWith("/exchange") ? exchange.promise : original(url, init),
    );
    const login = h.auth.login();
    await vi.waitFor(() => expect(h.auth.status().userCode).toBeTruthy());
    await h.auth.logout();
    exchange.resolve(h.response(h.record.credential));
    await login;
    expect(h.store.write).not.toHaveBeenCalled();
    expect(h.calls.filter((url) => url.endsWith("/logout"))).toHaveLength(1);
    expect(h.auth.status().phase).toBe("logged_out");
  });
  it("serializes account removal after an already-started save so logout cannot resurrect on restart", async () => {
    const h = fixture(),
      saved = deferred<void>();
    const originalWrite = h.store.write.getMockImplementation()!;
    h.store.write.mockImplementation(async (value) => {
      await saved.promise;
      await originalWrite(value);
    });
    const login = h.auth.login();
    await vi.waitFor(() => expect(h.store.write).toHaveBeenCalled());
    const logout = h.auth.logout();
    await vi.waitFor(() => expect(h.options.disconnectComputer).toHaveBeenCalled());
    expect(h.store.remove).not.toHaveBeenCalled();
    saved.resolve();
    await Promise.all([login, logout]);
    expect(h.saved()).toBeNull();
    expect(h.auth.status().phase).toBe("logged_out");
  });
  it("removes an already-started save after cancel even when remote revocation is offline", async () => {
    const h = fixture(),
      saved = deferred<void>();
    const originalWrite = h.store.write.getMockImplementation()!;
    const originalHttp = h.http.getMockImplementation()!;
    h.store.write.mockImplementation(async (value) => {
      await saved.promise;
      await originalWrite(value);
    });
    h.http.mockImplementation((url, init) =>
      String(url).endsWith("/logout")
        ? Promise.reject(new TypeError("network unavailable"))
        : originalHttp(url, init),
    );
    const login = h.auth.login();
    await vi.waitFor(() => expect(h.store.write).toHaveBeenCalled());
    h.auth.cancelLogin();
    saved.resolve();
    await login;
    expect(h.saved()).toBeNull();
    expect(h.auth.status().phase).toBe("logged_out");
  });
  it("discards late bootstrap and clears its cloud queue after logout", async () => {
    const h = fixture(true),
      bootstrap = deferred<Response>(),
      original = h.http.getMockImplementation()!;
    h.http.mockImplementation((url, init) =>
      String(url).endsWith("/bootstrap") ? bootstrap.promise : original(url, init),
    );
    const open = h.auth.authorizeCloud();
    await vi.waitFor(() =>
      expect(h.http.mock.calls.some(([url]) => String(url).endsWith("/bootstrap"))).toBe(true),
    );
    const logout = h.auth.logout();
    await vi.waitFor(() => expect(h.options.disconnectComputer).toHaveBeenCalled());
    bootstrap.resolve(
      h.response({
        ticket: "bootstrap-test-ticket-for-tests-only",
        expires_at: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    await expect(open).resolves.toBe(false);
    await logout;
    expect(h.options.openCloudSession).not.toHaveBeenCalled();
    expect(h.options.clearCloudSession).toHaveBeenCalledOnce();
  });
  it("waits for an already-started cloud load and then clears it, preventing a late logged-in window", async () => {
    const h = fixture(true),
      opened = deferred<void>();
    h.options.openCloudSession.mockImplementation(() => opened.promise);
    const open = h.auth.authorizeCloud();
    await vi.waitFor(() => expect(h.options.openCloudSession).toHaveBeenCalled());
    const logout = h.auth.logout();
    await vi.waitFor(() => expect(h.store.remove).toHaveBeenCalled());
    expect(h.options.clearCloudSession).not.toHaveBeenCalled();
    opened.resolve();
    await Promise.all([open, logout]);
    expect(h.options.clearCloudSession).toHaveBeenCalledOnce();
  });
  it("allows retry after cancel and never lets the old response replace the new login", async () => {
    const h = fixture(),
      oldExchange = deferred<Response>(),
      original = h.http.getMockImplementation()!;
    let exchangeCalls = 0;
    h.http.mockImplementation((url, init) => {
      if (String(url).endsWith("/exchange") && exchangeCalls++ === 0) return oldExchange.promise;
      return original(url, init);
    });
    const oldLogin = h.auth.login();
    await vi.waitFor(() => expect(exchangeCalls).toBe(1));
    h.auth.cancelLogin();
    await expect(h.auth.login()).resolves.toMatchObject({ phase: "authenticated" });
    const accepted = h.saved();
    oldExchange.resolve(h.response(h.record.credential));
    await expect(oldLogin).resolves.toMatchObject({ phase: "logged_out" });
    expect(h.saved()).toBe(accepted);
    expect(h.auth.status().phase).toBe("authenticated");
  });
  it("still removes account credentials and cloud sessions if Host cleanup fails, but reports incomplete logout", async () => {
    const h = fixture(true);
    h.options.disconnectComputer.mockRejectedValueOnce(new Error("Host cleanup failed"));
    await expect(h.auth.logout()).rejects.toThrow("退出清理未完成");
    expect(h.saved()).toBeNull();
    expect(h.options.clearCloudSession).toHaveBeenCalledOnce();
  });
});
