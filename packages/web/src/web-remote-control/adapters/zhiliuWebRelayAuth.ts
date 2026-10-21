import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type {
  WebRemoteControlAuthPort,
  WebRemoteControlCredentialChange,
  WebRemoteControlRegisteredDevice,
} from "#src/web-remote-control/contract.js";
import { withWebRemoteControlHttpSignal } from "#src/web-remote-control/adapters/webRemoteControlHttpSignal.js";

const GRANT_PATH = "/api/desktop-relay/terminal-grants";
const REFRESH_PATH = "/api/auth/refresh";
const LOGOUT_PATH = "/api/auth/logout";
const DEVICES_PATH = "/api/devices";
const REFRESH_MARGIN_MS = 30_000;
const RETRY_MS = 5_000;
const MIN_REFRESH_MS = 1_000;
const MAX_GRANT_TTL_MS = 5 * 60_000;
const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PRINCIPAL_PATTERN = new RegExp(`^${UUID}:${UUID}$`, "iu");
const DEVICE_ID_PATTERN = new RegExp(`^${UUID}$`, "iu");
const GRANT_PATTERN = /^rc_[A-Za-z0-9_-]{37,125}$/u;
const TOKEN_LIMIT = 16_384;
class StaleSaasSession extends Error {}

interface Grant {
  token: string;
  expiresAt: number;
  identity: string;
  rootToken: string;
}

export interface ZhiliuWebRelayAuthOptions {
  origin: string;
  /** 原 SaaS 的同标签页身份字段；不允许以 URL/跨 origin 获取。 */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  navigate(url: string): void;
  fetcher?: typeof fetch;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseGrant(value: unknown, now: number, rootToken: string): Grant {
  const data = record(value);
  const fields = [
    "protocol_version",
    "relay_grant",
    "expires_at",
    "principal_id",
    "desktop_device_id",
  ];
  if (
    !data ||
    Object.keys(data).length !== fields.length ||
    fields.some((key) => !(key in data)) ||
    data.protocol_version !== 1 ||
    typeof data.relay_grant !== "string" ||
    !GRANT_PATTERN.test(data.relay_grant) ||
    typeof data.expires_at !== "string" ||
    typeof data.principal_id !== "string" ||
    !PRINCIPAL_PATTERN.test(data.principal_id) ||
    data.desktop_device_id !== null
  )
    throw new WebRemoteControlV2ConnectionError("relay-unavailable");
  const expiresAt = Date.parse(data.expires_at);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > MAX_GRANT_TTL_MS + RETRY_MS
  )
    throw new WebRemoteControlV2ConnectionError("relay-unavailable");
  return { token: data.relay_grant, expiresAt, identity: data.principal_id, rootToken };
}

function parseRegisteredDevices(value: unknown): WebRemoteControlRegisteredDevice[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new WebRemoteControlV2ConnectionError("relay-unavailable");
  const devices = new Map<string, WebRemoteControlRegisteredDevice>();
  for (const item of value) {
    const data = record(item);
    if (
      !data ||
      data.status !== "active" ||
      data.revoked_at !== null ||
      typeof data.id !== "string" ||
      !DEVICE_ID_PATTERN.test(data.id) ||
      typeof data.name !== "string" ||
      !data.name.trim() ||
      data.name.length > 100 ||
      typeof data.platform !== "string" ||
      !data.platform.trim() ||
      data.platform.length > 40
    )
      continue;
    // 原生设备心跳不是 relay 在线事实，不能把其余返回字段传给 Entry。
    devices.set(data.id, { id: data.id, name: data.name.trim(), platform: data.platform.trim() });
  }
  return [...devices.values()];
}

/** HTTP/storage 边界单独持有 rc_；不向 Host、URL、日志或持久配置复制。 */
export class ZhiliuWebRelayAuth implements WebRemoteControlAuthPort {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private grant?: Grant;
  private generation = 0;
  private pending?: { controller: AbortController; promise: Promise<void> };
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private identityTimer?: ReturnType<typeof setInterval>;
  private readonly listeners = new Set<(change: WebRemoteControlCredentialChange) => void>();

  constructor(private readonly options: ZhiliuWebRelayAuthOptions) {
    const url = new URL(options.origin);
    if (url.origin !== options.origin || !["http:", "https:"].includes(url.protocol))
      throw new Error("Invalid SaaS origin");
    this.origin = url.origin;
    // 浏览器 fetch 需要 Window receiver；存成类字段再调用会触发 Illegal invocation。
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  getZCodeJwtToken(): string | null {
    return this.grant &&
      this.grant.expiresAt > this.now() &&
      this.grant.rootToken === this.accessToken()
      ? this.grant.token
      : null;
  }

  getSessionIdentity(): string | null {
    return this.grant?.rootToken === this.accessToken() ? this.grant.identity : null;
  }

  getActiveAccount(): null {
    return null;
  }

  subscribeCredentialChanged(
    listener: (change: WebRemoteControlCredentialChange) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prepareSession(signal: AbortSignal, force = false): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!force && this.getZCodeJwtToken() && this.grant!.expiresAt - this.now() > REFRESH_MARGIN_MS)
      return Promise.resolve();
    if (!this.pending) this.beginRefresh();
    return this.waitForRefresh(this.pending!.promise, signal);
  }

  async listRegisteredDevices(signal: AbortSignal): Promise<WebRemoteControlRegisteredDevice[]> {
    await this.prepareSession(signal);
    const generation = this.generation;
    const identity = this.getSessionIdentity();
    let token = this.accessToken();
    if (!identity || !token) throw new WebRemoteControlV2ConnectionError("auth-required");
    try {
      return await withWebRemoteControlHttpSignal(signal, async (requestSignal) => {
        const assertCurrent = () => {
          if (requestSignal.aborted)
            throw requestSignal.reason ?? new DOMException("Request aborted", "AbortError");
          if (
            generation !== this.generation ||
            token !== this.accessToken() ||
            identity !== this.getSessionIdentity()
          )
            throw new StaleSaasSession();
        };
        const request = () =>
          this.fetcher(new URL(DEVICES_PATH, this.origin), {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: requestSignal,
          });
        assertCurrent();
        let response = await request();
        assertCurrent();
        if (response.status === 401) {
          // 根身份刷新只由现有 pending owner 执行，不能与后台 grant 轮换并行写 sessionStorage。
          if (this.pending) await this.waitForRefresh(this.pending.promise, requestSignal);
          if (
            requestSignal.aborted ||
            generation !== this.generation ||
            identity !== this.getSessionIdentity()
          )
            throw new StaleSaasSession();
          if (token && token === this.accessToken()) {
            if (!this.pending) this.beginRefresh(token);
            await this.waitForRefresh(this.pending!.promise, requestSignal);
          }
          token = this.accessToken();
          assertCurrent();
          response = await request();
          assertCurrent();
        }
        if (response.status === 401 || response.status === 403)
          throw new WebRemoteControlV2ConnectionError("auth-required");
        if (!response.ok)
          throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
        const value: unknown = await response.json();
        assertCurrent();
        return parseRegisteredDevices(value);
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof WebRemoteControlV2ConnectionError
        ? error
        : new WebRemoteControlV2ConnectionError("relay-unavailable", true);
    }
  }

  startLogin(options?: Parameters<WebRemoteControlAuthPort["startLogin"]>[0]): void {
    const target = new URL(options?.appReturnTo ?? "/remote/v4", this.origin);
    const safeUrl = new URL("/remote/v4", this.origin);
    if (target.origin === this.origin && /^\/remote\/v4\/?$/u.test(target.pathname)) {
      for (const key of ["sid", "mid", "name", "app_version"]) {
        const value = target.searchParams.get(key);
        if (value && value.length <= 512) safeUrl.searchParams.set(key, value);
      }
    }
    const safeTarget = safeUrl.pathname + safeUrl.search;
    this.options.navigate(new URL(`/?next=${encodeURIComponent(safeTarget)}`, this.origin).href);
  }

  async logout(): Promise<void> {
    const token = this.accessToken();
    this.clear();
    try {
      if (token)
        await withWebRemoteControlHttpSignal(new AbortController().signal, (signal) =>
          this.fetcher(new URL(LOGOUT_PATH, this.origin), {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            signal,
          }),
        );
    } catch {
      // 本地退出始终清理；服务端撤销失败由既有会话期限约束，不恢复旧授权。
    } finally {
      if (this.accessToken() === token) this.clearSaasSession();
      this.emit("authorization-lost");
    }
  }

  dispose(): void {
    this.clear();
    this.listeners.clear();
  }

  private accessToken(): string | null {
    try {
      return this.options.storage.getItem(ACCESS_KEY);
    } catch {
      return null;
    }
  }

  private clearSaasSession(): void {
    for (const key of [ACCESS_KEY, REFRESH_KEY, "profile"]) this.options.storage.removeItem(key);
  }

  private clear(): void {
    this.generation++;
    this.pending?.controller.abort();
    this.pending = undefined;
    clearTimeout(this.refreshTimer);
    clearInterval(this.identityTimer);
    this.refreshTimer = undefined;
    this.identityTimer = undefined;
    this.grant = undefined;
  }

  private emit(change: WebRemoteControlCredentialChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private beginRefresh(failedAccessToken?: string): void {
    const controller = new AbortController();
    const generation = this.generation;
    const previous = this.grant;
    const pending = { controller, promise: Promise.resolve() };
    pending.promise = this.issue(controller.signal, generation, failedAccessToken)
      .then((grant) => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.grant = grant;
        this.scheduleRefresh();
        if (!this.identityTimer)
          this.identityTimer = setInterval(() => {
            if (!this.pending && this.grant && this.grant.rootToken !== this.accessToken()) {
              const loggedIn = Boolean(this.accessToken());
              this.clear();
              this.emit(loggedIn ? "identity" : "authorization-lost");
            }
          }, RETRY_MS);
        if (previous) this.emit(previous.identity === grant.identity ? "credential" : "identity");
      })
      .catch((error) => {
        if (generation !== this.generation || controller.signal.aborted) throw error;
        if (error instanceof StaleSaasSession) {
          // 迟到回包只能撤销旧代次，不能把新账号的 sessionStorage 当作旧账号清掉。
          this.clear();
          this.emit(this.accessToken() ? "identity" : "authorization-lost");
          throw new WebRemoteControlV2ConnectionError("auth-required");
        }
        if (
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          this.clear();
          this.clearSaasSession();
          this.emit("authorization-lost");
        }
        throw error instanceof WebRemoteControlV2ConnectionError
          ? error
          : new WebRemoteControlV2ConnectionError("relay-unavailable", true);
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => this.refreshInBackground(),
      Math.max(MIN_REFRESH_MS, this.grant!.expiresAt - this.now() - REFRESH_MARGIN_MS),
    );
  }

  private refreshInBackground(): void {
    void this.prepareSession(new AbortController().signal).catch(() => {
      if (this.grant) this.refreshTimer = setTimeout(() => this.refreshInBackground(), RETRY_MS);
    });
  }

  private async issue(
    signal: AbortSignal,
    generation: number,
    failedAccessToken?: string,
  ): Promise<Grant> {
    let token = this.accessToken();
    if (!token) throw new WebRemoteControlV2ConnectionError("auth-required");
    return withWebRemoteControlHttpSignal(signal, async (requestSignal) => {
      const refreshRejectedRoot = failedAccessToken === token;
      if (refreshRejectedRoot)
        token = await this.refreshAccessToken(token!, requestSignal, generation);
      const request = () =>
        this.fetcher(new URL(GRANT_PATH, this.origin), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: requestSignal,
        });
      let response = await request();
      if (token !== this.accessToken()) throw new StaleSaasSession();
      if (response.status === 401 && !refreshRejectedRoot) {
        token = await this.refreshAccessToken(token!, requestSignal, generation);
        response = await request();
      }
      if (token !== this.accessToken()) throw new StaleSaasSession();
      if (response.status === 401 || response.status === 403)
        throw new WebRemoteControlV2ConnectionError("auth-required");
      if (!response.ok)
        throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
      const grant = parseGrant(await response.json(), this.now(), token!);
      if (generation !== this.generation || token !== this.accessToken())
        throw new StaleSaasSession();
      return grant;
    });
  }

  private async refreshAccessToken(
    failedToken: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<string> {
    const refreshToken = this.options.storage.getItem(REFRESH_KEY);
    if (!refreshToken) throw new WebRemoteControlV2ConnectionError("auth-required");
    const response = await this.fetcher(new URL(REFRESH_PATH, this.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (
      generation !== this.generation ||
      failedToken !== this.accessToken() ||
      refreshToken !== this.options.storage.getItem(REFRESH_KEY)
    )
      throw new StaleSaasSession();
    if (response.status === 401 || response.status === 403)
      throw new WebRemoteControlV2ConnectionError("auth-required");
    if (!response.ok)
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
    const value = record(await response.json());
    if (
      !value ||
      typeof value.access_token !== "string" ||
      !value.access_token ||
      value.access_token.length > TOKEN_LIMIT ||
      typeof value.refresh_token !== "string" ||
      !value.refresh_token ||
      value.refresh_token.length > TOKEN_LIMIT
    )
      throw new WebRemoteControlV2ConnectionError("relay-unavailable");
    if (
      generation !== this.generation ||
      failedToken !== this.accessToken() ||
      refreshToken !== this.options.storage.getItem(REFRESH_KEY)
    )
      throw new StaleSaasSession();
    this.options.storage.setItem(ACCESS_KEY, value.access_token);
    this.options.storage.setItem(REFRESH_KEY, value.refresh_token);
    return value.access_token;
  }

  private waitForRefresh(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
