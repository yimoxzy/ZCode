import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedModelBroker } from "../src/zhiliu-runtime/index.js";
import { exampleRuntimeGrant } from "../src/zhiliu-runtime/contract.example.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});
async function setup(input: Partial<Parameters<typeof createManagedModelBroker>[0]> = {}) {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }),
        { headers: { "content-type": "application/json", "x-zhiliu-model-call-id": "call-one" } },
      ),
    );
  const revoke = vi.fn(async () => {});
  const broker = await createManagedModelBroker({
    initial: { origin: "https://platform.example", grant: exampleRuntimeGrant },
    renew: async () => ({ origin: "https://platform.example", grant: exampleRuntimeGrant }),
    revoke,
    http,
    ...input,
  });
  disposals.push(broker.dispose);
  const post = (
    options: { headers?: Record<string, string>; path?: string; body?: unknown } = {},
  ) =>
    fetch(`${broker.profile.gatewayBaseUrl}${options.path ?? "/chat/completions"}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${broker.profile.capabilityToken}`,
        "Content-Type": "application/json",
        "x-request-id": "model-call-one",
        ...options.headers,
      },
      body: JSON.stringify(
        options.body ?? { model: "zhiliu-managed", messages: [{ role: "user", content: "test" }] },
      ),
    });
  return { broker, http, revoke, post };
}
describe("本机托管模型broker", () => {
  it("发行的write gate仅注入强制单次审批，不设置全局allowlist剪裁原生工具", async () => {
    const { broker } = await setup({
      initial: {
        origin: "https://platform.example",
        grant: {
          ...exampleRuntimeGrant,
          profile: { ...exampleRuntimeGrant.profile, platform_tools_write_enabled: true },
        },
      },
    });
    expect(broker.profile.approvalRequiredTools).toEqual([
      "mcp__zhiliu_platform__save_personal_memory",
    ]);
    expect(broker.profile.toolAllowlist).toBeUndefined();
    const readOnly = await setup();
    expect(readOnly.broker.profile.approvalRequiredTools).toBeUndefined();
  });
  it("平台MCP使用独立capability和固定目标，透传稳定工具幂等键而不缓存结果", async () => {
    const { broker, http } = await setup();
    const tools = broker.profile.platformTools!;
    expect(tools.capabilityToken).not.toBe(broker.profile.capabilityToken);
    const rpc = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_personal_memory", arguments: { query: "最近工作" } },
    };
    const call = (token = tools.capabilityToken, headers: Record<string, string> = {}) =>
      fetch(tools.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": "tool:original-call-one",
          ...headers,
        },
        body: JSON.stringify(rpc),
      });
    expect((await call(broker.profile.capabilityToken)).status).toBe(401);
    expect((await call(tools.capabilityToken, { Origin: "https://evil.example" })).status).toBe(
      401,
    );
    expect((await call(tools.capabilityToken, { "Idempotency-Key": "rpc-id-3" })).status).toBe(422);
    expect(http).not.toHaveBeenCalled();
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(http).toHaveBeenCalledTimes(2);
    const [url, request] = http.mock.calls[0]!;
    expect(url).toBe("https://platform.example/api/runtime-gateway/mcp");
    expect(request?.headers).toMatchObject({
      Authorization: `Bearer ${exampleRuntimeGrant.runtime_grant}`,
      "Idempotency-Key": "tool:original-call-one",
    });
    expect(JSON.parse(String(request?.body))).toEqual(rpc);
    expect(request?.redirect).toBe("error");
    expect(JSON.stringify(broker.profile)).not.toContain(exampleRuntimeGrant.runtime_grant);
  });
  it("MCP初始化允许无调用键，任意路径、方法、batch和过大body拒绝", async () => {
    const { broker, http } = await setup();
    const tools = broker.profile.platformTools!;
    const post = (body: unknown, path = tools.url) =>
      fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${tools.capabilityToken}` },
        body: JSON.stringify(body),
      });
    expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(
      200,
    );
    expect(http).toHaveBeenCalledTimes(1);
    expect((await post({ jsonrpc: "2.0", id: 2, method: "admin/delete" })).status).toBe(422);
    expect((await post([{ jsonrpc: "2.0", id: 2, method: "tools/list" }])).status).toBe(422);
    expect(
      (await post({ jsonrpc: "2.0", method: "tools/list", padding: "x".repeat(1024 * 1024) }))
        .status,
    ).toBe(413);
    expect((await post({}, `${tools.url}?target=evil`)).status).toBe(401);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("只下发本机capability，转发时替换凭据且不信客户端cookie", async () => {
    const { broker, http, post } = await setup();
    expect(JSON.stringify(broker.profile)).not.toContain(exampleRuntimeGrant.runtime_grant);
    const response = await post({
      headers: { Cookie: "secret=bad", "x-zcode-trace-id": "trace-one" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-zhiliu-model-call-id")).toBe("call-one");
    expect(await response.json()).toMatchObject({ usage: { prompt_tokens: 2 } });
    const [url, request] = http.mock.calls[0]!;
    expect(url).toBe("https://platform.example/api/runtime-gateway/v1/chat/completions");
    expect(request?.headers).toMatchObject({
      Authorization: `Bearer ${exampleRuntimeGrant.runtime_grant}`,
      "Idempotency-Key": "model-call-one",
      "x-zcode-trace-id": "trace-one",
    });
    expect(JSON.stringify(request?.headers)).not.toContain("secret=bad");
    expect(request?.redirect).toBe("error");
  });
  it("错误cap、浏览器来源、跨协议与任意模型都不能触发上游", async () => {
    const { post, http } = await setup();
    expect((await post({ headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
    expect((await post({ headers: { Origin: "https://evil.example" } })).status).toBe(401);
    expect((await post({ path: "/responses" })).status).toBe(403);
    expect((await post({ body: { model: "unmanaged" } })).status).toBe(422);
    expect((await post({ headers: { "x-request-id": "" } })).status).toBe(422);
    expect(http).not.toHaveBeenCalled();
  });
  it("临期续期single-flight且固定capability不会泄露grant", async () => {
    const now = Date.now();
    const grant = { ...exampleRuntimeGrant, expires_at: new Date(now + 1000).toISOString() };
    const renew = vi.fn(async () => ({
      origin: "https://platform.example",
      grant: { ...exampleRuntimeGrant, runtime_grant: "rg_new_secret_1234567890123456789" },
    }));
    const http = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const { post, broker, revoke } = await setup({
      initial: { origin: "https://platform.example", grant },
      renew,
      http,
      now: () => now,
    });
    const responses = await Promise.all([
      post(),
      post({ headers: { "x-request-id": "model-call-two" } }),
    ]);
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalled();
    expect(JSON.stringify(broker.profile)).not.toContain("rg_new_secret");
  });
  it("关闭先abort在途模型，再撤销；关闭后不能继续调用", async () => {
    let signal: AbortSignal | undefined;
    const http = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    });
    const { post, broker, revoke } = await setup({ http });
    const request = post().catch(() => null);
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1));
    await broker.dispose();
    await request;
    expect(signal?.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    await expect(post()).rejects.toThrow();
  });
});
