import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createRelayIntrospector, createZhiliuRelay, type RelayPrincipal } from "../src/index.js";
import { exampleRelayPrincipal } from "../src/contract.example.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});
const rc = (suffix: string) => `rc_test_non_secret_${suffix}_01234567890123456789`;
async function setup() {
  const grants = new Map<string, RelayPrincipal>();
  const revoked = new Set<string>();
  const introspect = vi.fn(async (grant: string) => {
    const principal = grants.get(grant);
    if (!principal || revoked.has(grant)) throw new Error("revoked");
    return principal;
  });
  const relay = await createZhiliuRelay({
    publicOrigin: "https://platform.example",
    introspect,
    revalidateIntervalMs: 25,
  });
  disposals.push(relay.close);
  function add(suffix: string, overrides: Partial<RelayPrincipal> = {}) {
    const principal = { ...exampleRelayPrincipal, ...overrides };
    principal.principal_id = `${principal.user_id}:${principal.space_id}`;
    const grant = rc(suffix);
    grants.set(grant, principal);
    return grant;
  }
  const deviceGrant = add("device");
  const terminalGrant = add("terminal", {
    role: "terminal",
    desktop_device_id: null,
    device_mid: null,
  });
  const request = (path: string, grant: string, body?: unknown) =>
    fetch(`${relay.httpUrl}/api/v1/remote/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function token(grant: string, role: "device" | "terminal") {
    const response = await request("token", grant, { role });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { data: { token: string } };
    return data.data.token;
  }
  async function open(grant: string, role: "device" | "terminal", sid: string) {
    const value = await token(grant, role);
    const socket = new WebSocket(`${relay.wsUrl}?token=${value}`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (bytes) =>
      messages.push(JSON.parse(bytes.toString()) as Record<string, unknown>),
    );
    socket.on("error", () => {});
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "auth_init",
        device_sid: sid,
        ...(role === "device" ? { meta: { name: "测试电脑" } } : {}),
      }),
    );
    await vi.waitFor(() =>
      expect(messages.some((item) => item.type === "auth_ack" || item.type === "error")).toBe(true),
    );
    return { socket, messages, token: value };
  }
  async function register(grant = deviceGrant, mid = exampleRelayPrincipal.device_mid) {
    const response = await request("device", grant, { device_mid: mid });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { device_sid: string } }).data.device_sid;
  }
  return {
    relay,
    grants,
    revoked,
    introspect,
    add,
    deviceGrant,
    terminalGrant,
    request,
    register,
    open,
  };
}
describe("织流生产薄relay HTTP/WS", () => {
  it("真实双向payload传输与设备在线列表，撤销根授权后断开而不保有任务", async () => {
    const h = await setup(),
      sid = await h.register();
    const device = await h.open(h.deviceGrant, "device", sid);
    expect(device.messages[0]).toMatchObject({ type: "auth_ack", pair_status: "waiting" });
    const terminal = await h.open(h.terminalGrant, "terminal", sid);
    expect(terminal.messages[0]).toMatchObject({ type: "auth_ack", pair_status: "matched" });
    expect(await (await h.request("device", h.terminalGrant)).json()).toMatchObject({
      code: 0,
      data: [{ device_sid: sid, online: true, meta: { name: "测试电脑" } }],
    });
    terminal.socket.send(
      JSON.stringify({
        type: "data",
        payload: { task: "opaque-v4-rpc", user_id: "untrusted-payload-value" },
      }),
    );
    await vi.waitFor(() =>
      expect(device.messages).toContainEqual(
        expect.objectContaining({
          type: "data",
          payload: { task: "opaque-v4-rpc", user_id: "untrusted-payload-value" },
        }),
      ),
    );
    device.socket.send(
      JSON.stringify({ type: "data", payload: { event: "opaque-result", sequence: 1 } }),
    );
    await vi.waitFor(() =>
      expect(terminal.messages).toContainEqual(
        expect.objectContaining({ type: "data", payload: { event: "opaque-result", sequence: 1 } }),
      ),
    );
    h.revoked.add(h.deviceGrant);
    await vi.waitFor(() => expect(device.socket.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() =>
      expect(terminal.messages).toContainEqual(
        expect.objectContaining({ type: "error", code: "DEVICE_OFFLINE" }),
      ),
    );
  });
  it("user、space、目标native设备与角色都隔离，MID不能冒用", async () => {
    const h = await setup(),
      sid = await h.register();
    await h.open(h.deviceGrant, "device", sid);
    expect(
      (
        await h.request("device", h.deviceGrant, {
          device_mid: "00000000-0000-4000-8000-000000000099",
        })
      ).status,
    ).toBe(403);
    expect((await h.request("token", h.terminalGrant, { role: "device" })).status).toBe(403);
    for (const [suffix, overrides] of [
      ["other-user", { user_id: "00000000-0000-4000-8000-000000000099" }],
      ["other-space", { space_id: "00000000-0000-4000-8000-000000000099" }],
      ["other-device", { desktop_device_id: "00000000-0000-4000-8000-000000000099" }],
    ] as const) {
      const grant = h.add(suffix, {
        role: "terminal",
        device_mid: null,
        desktop_device_id: null,
        ...overrides,
      });
      expect(await (await h.request("device", grant)).json()).toMatchObject({ data: [] });
      const other = await h.open(grant, "terminal", sid);
      expect(other.messages).toContainEqual(
        expect.objectContaining({ type: "error", code: "AUTH_FAILED" }),
      );
    }
    const response = await h.request("device", "dl_should_never_be_accepted_by_relay_0123456789");
    expect(response.status).toBe(401);
    expect(h.introspect.mock.calls.every(([grant]) => grant.startsWith("rc_"))).toBe(true);
  });
  it("WS token单次消费，同角色替换的迟到close不能拆掉新owner", async () => {
    const h = await setup(),
      sid = await h.register();
    const old = await h.open(h.deviceGrant, "device", sid);
    const terminal = await h.open(h.terminalGrant, "terminal", sid);
    const replacement = await h.open(h.deviceGrant, "device", sid);
    await vi.waitFor(() => expect(old.socket.readyState).toBe(WebSocket.CLOSED));
    expect(old.messages).toContainEqual(expect.objectContaining({ type: "error", code: "KICKED" }));
    terminal.socket.send(
      JSON.stringify({ type: "data", payload: { request: "after-owner-replacement" } }),
    );
    await vi.waitFor(() =>
      expect(replacement.messages).toContainEqual(
        expect.objectContaining({ type: "data", payload: { request: "after-owner-replacement" } }),
      ),
    );
    const reused = new WebSocket(`${h.relay.wsUrl}?token=${replacement.token}`);
    const status = await new Promise<number>((resolve) => {
      reused.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        reused.terminate();
      });
      reused.on("error", () => {});
    });
    expect(status).toBe(401);
  });
  it("内省只向固定端点传service凭据并拒绝重定向", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(exampleRelayPrincipal), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const introspect = createRelayIntrospector({
      url: "http://api.internal/api/internal/desktop-relay/introspect",
      serviceToken: "service-test-not-real",
      http,
    });
    expect(await introspect(rc("device"))).toEqual(exampleRelayPrincipal);
    expect(http.mock.calls[0]![0].toString()).toBe(
      "http://api.internal/api/internal/desktop-relay/introspect",
    );
    expect(http.mock.calls[0]![1]).toMatchObject({
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer service-test-not-real" },
    });
    expect(http.mock.calls[0]![1]!.body).toBe(JSON.stringify({ relay_grant: rc("device") }));
  });
});
