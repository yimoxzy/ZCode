import type { McpServerConfig } from "@zcode/contracts";
import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";
import { withoutNetworkCapture } from "@zcode/shared/node";

export const PLATFORM_MCP_SERVER = "zhiliu_platform";
export const PLATFORM_MCP_TOOL_PREFIX = "mcp__zhiliu_platform__";
type PlatformTools = NonNullable<ZhiliuManagedRuntimeProfile["platformTools"]>;

/** No credential is included in serializable MCP configuration. */
export function createManagedMcpServers(tools?: PlatformTools): Record<string, McpServerConfig> {
  return tools ? {[PLATFORM_MCP_SERVER]: {
    type: "http", url: tools.url, enabled: true, alwaysLoad: true,
    isolation: "session", protocolVersion: "legacy", timeoutMs: tools.timeoutMs ?? 1800000,
  }} : {};
}

export function createManagedToolTransport(tools: PlatformTools): typeof globalThis.fetch {
  const url = new URL(tools.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
    throw new Error("zhiliu_managed_tool_target_rejected");
  }
  const endpoint = tools.url;
  const capability = tools.capabilityToken;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint || !["POST", "GET", "DELETE"].includes(request.method)) {
      throw new Error("zhiliu_managed_tool_target_rejected");
    }
    const headers = new Headers(request.headers);
    for (const name of Array.from(headers.keys())) {
      if (/authorization|api[-_]?key|cookie|capability/i.test(name)) headers.delete(name);
    }
    headers.set("authorization", `Bearer ${capability}`);
    let body: string | undefined;
    if (request.method === "POST") {
      body = await request.text();
      const frame = JSON.parse(body) as {method?: string; params?: {_meta?: Record<string, unknown>}};
      if (frame.method === "tools/call") {
        const callId = frame.params?._meta?.tool_call_id;
        if (typeof callId !== "string" || !/^[\x21-\x7E]{1,512}$/u.test(callId)) {
          throw new Error("zhiliu_managed_tool_identity_required");
        }
        headers.set("idempotency-key", `tool:${callId}`);
      }
    }
    return withoutNetworkCapture(() => globalThis.fetch(endpoint, {
      method: request.method, headers, body, signal: request.signal, redirect: "error",
    }));
  };
}
