import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";
import { createModelRequestSecurityState } from "../../adapters/src/model/request-security-edition/index.js";
import { createManagedProcessProviderRuntime, createManagedContextSource, createManagedSkillPort } from "../src/managed-runtime/index.js";
import { readManagedRuntimeProfile, readManagedPrompt } from "../../cli/src/managed-profile-input.js";
import { discoverNodePluginsSync } from "../../adapters/src/plugins/index.js";
import { createManagedMcpServers, createManagedToolTransport } from "../src/managed-runtime/platform-tools.js";
import { createMcpAdapter } from "../../adapters/src/mcp/index.js";

const profile: ZhiliuManagedRuntimeProfile = {
  version: 1, gatewayBaseUrl: "http://127.0.0.1:12345/v1",
  capabilityToken: "test_capability_123456789012345678901234", modelId: "zhiliu-managed",
  protocol: "responses", maxContextTokens: 128000, maxOutputTokens: 4096,
};
afterEach(() => vi.unstubAllGlobals());

describe("managed runtime startup", () => {
  it("consumes one first frame and preserves same-chunk prompt and RPC bytes", async () => {
    const input = new PassThrough();
    input.end(`${JSON.stringify(profile)}\n${JSON.stringify({text: "hello\nworld"})}\n{"id":2}\n`);
    expect(await readManagedRuntimeProfile(input)).toEqual(profile);
    expect(await readManagedPrompt(input)).toBe("hello\nworld");
    expect(input.read()?.toString()).toBe('{"id":2}\n');
  });

  it("handles chunk splits and rejects invalid targets without echoing credentials", async () => {
    const input = new PassThrough();
    const result = readManagedRuntimeProfile(input);
    const frame = JSON.stringify(profile);
    input.write(frame.slice(0, 30));
    input.end(frame.slice(30) + "\n");
    expect(await result).toEqual(profile);
    const bad = new PassThrough();
    bad.end(JSON.stringify({...profile, gatewayBaseUrl: "https://outside.example/v1"}) + "\n");
    await expect(readManagedRuntimeProfile(bad)).rejects.toThrow(/^Managed runtime profile is invalid$/);
    const missing = new PassThrough(); missing.end("secret");
    await expect(readManagedRuntimeProfile(missing)).rejects.toThrow("Managed startup frame is missing");
    const huge = new PassThrough(); huge.end("x".repeat(1024 * 1024 + 1));
    await expect(readManagedRuntimeProfile(huge)).rejects.toThrow("too large");
  });

  it("publishes only the virtual model and never places capability in provider config", async () => {
    const runtime = await createManagedProcessProviderRuntime(profile);
    try {
      expect(runtime.runtime.registryService.listProviders().map(p => p.providerId)).toEqual(["zhiliu-managed"]);
      expect(runtime.runtime.registryService.validateSelection(runtime.configuredDefaultModelSelection)).toMatchObject({ok: true});
      expect(runtime.runtime.registryService.getProvider("outside")).toBeUndefined();
      expect(JSON.stringify(runtime.snapshot)).not.toContain(profile.capabilityToken);
      await expect(runtime.runtime.personalRepository.update(() => undefined as never)).rejects.toThrow("zhiliu_managed_models_only");
    } finally { runtime.dispose(); }
  });

  it.each([true, false, undefined])("uses the frozen image capability %s with legacy compatibility", async (supportsImage) => {
    const runtime = await createManagedProcessProviderRuntime({...profile, supportsImage});
    try {
      expect(runtime.runtime.registryService.getModel("zhiliu-managed", "zhiliu-managed")?.config.properties.inputFormat.supportsImage)
        .toBe(supportsImage ?? true);
    } finally { runtime.dispose(); }
  });

  it("appends persona as instruction material while approved empty roots suppress local discovery", async () => {
    const base = {resolveContextSources: vi.fn(async (request) => ({...request, envInfo: {}, diagnostics: []}))};
    const source = createManagedContextSource(base as never, {...profile, instructions: "平台 persona", pluginManifest: {roots: []}});
    const result = await source.resolveContextSources({workingDirectory: process.cwd(), userInstructions: {workingDirectory: process.cwd()}});
    expect(base.resolveContextSources.mock.calls[0]?.[0].userInstructions).toBeUndefined();
    expect(result.userInstructions?.content).toBe("平台 persona");
    const skills = await createManagedSkillPort([]).discoverSkills({workingDirectory: process.cwd()});
    expect(skills.skills).toEqual([]);
  });

  it("uses only published plugin roots despite an installed official plugin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "managed-plugin-roots-"));
    try {
      const approved = join(dir, "approved"); const other = join(dir, "other");
      for (const [root, name] of [[approved, "approved"], [other, "other"]]) {
        await mkdir(join(root, ".zcode-plugin"), {recursive: true});
        await writeFile(join(root, ".zcode-plugin", "plugin.json"), JSON.stringify({name, version: "1.0.0"}));
      }
      const base = {config: {enabled: true, dirs: [approved], enabledPlugins: {}, options: {}, suppressedBuiltins: []},
        storageRoot: join(dir, "cache"), workingDirectory: dir, officialPluginRoots: [other], explicitPluginRootsOnly: true};
      expect(discoverNodePluginsSync(base).plugins.map(p => p.name)).toEqual(["approved"]);
      expect(discoverNodePluginsSync({...base, config: {...base.config, dirs: []}}).plugins).toEqual([]);
    } finally {await rm(dir, {recursive: true, force: true});}
  });
});

describe("managed final network boundary", () => {
  it("cancels a pending MCP tool through the existing SDK notification without replay", async () => {
    let started!: () => void; const startedPromise = new Promise<void>(resolve => {started = resolve;});
    let cancelled!: () => void; const cancelledPromise = new Promise<void>(resolve => {cancelled = resolve;});
    let callCount = 0;
    const toolCapability = "independent_tool_capability_12345678901234567890";
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${toolCapability}`);
      if (req.method !== "POST") {res.writeHead(req.method === "DELETE" ? 204 : 405); res.end(); return;}
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const frame = JSON.parse(Buffer.concat(chunks).toString());
      if (frame.method === "notifications/cancelled") cancelled();
      if (!Object.hasOwn(frame, "id")) {res.writeHead(202); res.end(); return;}
      if (frame.method === "tools/call") {callCount += 1; started(); return;}
      const result = frame.method === "initialize" ? {protocolVersion: frame.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: "test", version: "1"}}
        : frame.method === "tools/list" ? {tools: [{name: "wait", inputSchema: {type: "object"}}]} : {};
      res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify({jsonrpc: "2.0", id: frame.id, result}));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address missing");
    const tools = {url: `http://127.0.0.1:${address.port}/mcp`, capabilityToken: toolCapability, timeoutMs: 5000};
    const port = createMcpAdapter({trustedServerTransports: {zhiliu_platform: {url: tools.url, fetch: createManagedToolTransport(tools), singleAttempt: true}}});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await port.connectServer("zhiliu_platform", createManagedMcpServers(tools).zhiliu_platform)).status).toBe("connected");
      const abort = new AbortController();
      const pending = port.callTool({serverName: "zhiliu_platform", toolName: "wait", toolCallId: "call_cancel"}, {signal: abort.signal});
      const rejected = expect(pending).rejects.toThrow();
      await startedPromise; abort.abort(new Error("user cancelled"));
      await rejected;
      await Promise.race([cancelledPromise, new Promise((_, reject) => {timeout = setTimeout(() => reject(new Error("MCP cancellation notification missing")), 2500);})]);
      expect(callCount).toBe(1);
    } finally {
      clearTimeout(timeout); await port.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("keeps platform tool credentials out of config and forces fixed tool request identity", async () => {
    const tools = {url: "http://127.0.0.1:12345/mcp", capabilityToken: "separate_tool_capability_12345678901234567890"};
    expect(JSON.stringify(createManagedMcpServers(tools))).not.toContain(tools.capabilityToken);
    const fetchSpy = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetchSpy);
    const transport = createManagedToolTransport(tools);
    await expect(transport("http://127.0.0.1:42/mcp", {method: "POST", body: "{}"})).rejects.toThrow("target_rejected");
    await expect(transport(tools.url, {method: "POST", body: '{"method":"tools/call","params":{}}'})).rejects.toThrow("identity_required");
    const abort = new AbortController();
    await transport(tools.url, {method: "POST", signal: abort.signal,
      headers: {authorization: "wrong", "x-api-key": "wrong"},
      body: '{"method":"tools/call","params":{"_meta":{"tool_call_id":"call_1"}}}'});
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${tools.capabilityToken}`);
    expect(new Headers(init.headers).get("idempotency-key")).toBe("tool:call_1");
    expect(new Headers(init.headers).get("x-api-key")).toBeNull();
    expect(init.redirect).toBe("error"); abort.abort(); expect(init.signal?.aborted).toBe(true);
  });
  it("forces local bearer capability, virtual model and stateless Responses", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const forbiddenTransport = vi.fn();
    const transport = createModelRequestSecurityState(profile).createExecution({}).protectTransport({
      providerId: "zhiliu-managed", providerConfig: {} as never, transport: forbiddenTransport,
    });
    await transport(`${profile.gatewayBaseUrl}/responses`, {method: "POST", headers: {
      authorization: "Bearer upstream-secret", "x-api-key": "foreign-key", cookie: "secret", "x-request-id": "request-1",
    }, body: JSON.stringify({model: "zhiliu-managed", store: true, input: "hello"})});
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${profile.gatewayBaseUrl}/responses`);
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${profile.capabilityToken}`);
    expect(headers.get("x-api-key")).toBeNull(); expect(headers.get("cookie")).toBeNull();
    expect(headers.get("idempotency-key")).toBe("request-1");
    expect(JSON.parse(init.body as string).store).toBe(false);
    expect(forbiddenTransport).not.toHaveBeenCalled();
  });

  it("rejects endpoint/model changes and stateful requests before network", async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const transport = createModelRequestSecurityState(profile).createExecution({}).protectTransport({
      providerId: "zhiliu-managed", providerConfig: {} as never, transport: fetchSpy,
    });
    await expect(transport("http://127.0.0.1:12346/v1/responses", {method: "POST", body: "{}"})).rejects.toThrow("target_rejected");
    await expect(transport(`${profile.gatewayBaseUrl}/responses`, {method: "POST", body: '{"model":"other"}'})).rejects.toThrow("model_rejected");
    await expect(transport(`${profile.gatewayBaseUrl}/responses`, {method: "POST", body: '{"model":"zhiliu-managed","previous_response_id":"resp_1"}'})).rejects.toThrow("stateful_request_rejected");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
