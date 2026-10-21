import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { zhiliuManagedRuntimeProfileSchema } from "@zcode/shared";
import type { OwnedRuntimeGrant } from "./contract.js";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_TOOL_REQUEST_BYTES = 1024 * 1024;
const RENEW_MARGIN_MS = 60000;
const REQUEST_ID = /^[A-Za-z0-9_.:/-]{1,160}$/u;
const TOOL_REQUEST_ID = /^tool:[\x21-\x7E]{1,512}$/u;
const FORWARDED_HEADERS = [
  "x-zcode-trace-id",
  "x-session-id",
  "x-query-id",
  "x-zcode-session-type",
  "x-zcode-query-source",
];

/** Broker 仅转发固定平台模型/MCP协议。钱包、工具ACL和usage真相始终属于云端。 */
export async function createManagedModelBroker(options: {
  initial: OwnedRuntimeGrant;
  renew: () => Promise<OwnedRuntimeGrant>;
  revoke: (grant: OwnedRuntimeGrant) => Promise<void>;
  http?: typeof fetch;
  now?: () => number;
}) {
  const capability = randomBytes(32).toString("base64url");
  const toolCapability = randomBytes(32).toString("base64url");
  const now = options.now ?? Date.now;
  const http = options.http ?? fetch;
  let current = options.initial;
  let closed = false;
  let renewing: Promise<OwnedRuntimeGrant> | undefined;
  const requests = new Set<AbortController>();
  const grantForRequest = async () => {
    if (closed) throw new Error("runtime_closed");
    if (Date.parse(current.grant.expires_at) - now() > RENEW_MARGIN_MS) return current;
    if (!renewing) {
      const previous = current;
      const pending = options.renew().then(async (next) => {
        if (closed) {
          await options.revoke(next).catch(() => {});
          throw new Error("runtime_closed");
        }
        // 旧CLI持有冻结的协议/上下文，不能让续期静默切到不兼容的模型档位。
        if (JSON.stringify(previous.grant.profile) !== JSON.stringify(next.grant.profile)) {
          await options.revoke(next).catch(() => {});
          throw new Error("runtime_profile_changed");
        }
        current = next;
        void options.revoke(previous).catch(() => {});
        return next;
      });
      renewing = pending;
      void pending
        .finally(() => {
          if (renewing === pending) renewing = undefined;
        })
        .catch(() => {});
    }
    return renewing;
  };
  let expectedHost = "";
  const fail = (response: ServerResponse, status: number, code: string) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(
      JSON.stringify({
        error: {
          type: "runtime_gateway_error",
          code,
          message: "织流模型请求未完成，请检查账号、积分或重新打开任务",
        },
      }),
    );
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const supplied = request.headers.authorization ?? "";
    const isTool = request.url === "/mcp";
    const expected = `Bearer ${isTool ? toolCapability : capability}`;
    if (
      closed ||
      request.headers.host !== expectedHost ||
      request.headers.origin ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      fail(response, 401, "runtime_capability_invalid");
      return;
    }
    const allowedPath = isTool
      ? "/mcp"
      : current.grant.profile.protocol === "responses"
        ? "/v1/responses"
        : "/v1/chat/completions";
    if (request.method !== "POST" || request.url !== allowedPath) {
      fail(response, 403, "runtime_endpoint_not_allowed");
      return;
    }
    const requestId = request.headers["idempotency-key"] ?? request.headers["x-request-id"];
    if (!isTool && (typeof requestId !== "string" || !REQUEST_ID.test(requestId))) {
      fail(response, 422, "runtime_request_id_required");
      return;
    }
    const controller = new AbortController();
    requests.add(controller);
    const disconnected = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.on("close", disconnected);
    request.on("aborted", () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > (isTool ? MAX_TOOL_REQUEST_BYTES : MAX_REQUEST_BYTES)) {
          fail(response, 413, "runtime_input_too_large");
          return;
        }
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        fail(response, 422, "runtime_json_invalid");
        return;
      }
      if (
        !isTool &&
        (!parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          (parsed as { model?: unknown }).model !== "zhiliu-managed")
      ) {
        fail(response, 422, "runtime_model_not_allowed");
        return;
      }
      if (isTool) {
        const rpc = parsed as { jsonrpc?: unknown; method?: unknown } | null;
        if (
          !rpc ||
          Array.isArray(rpc) ||
          rpc.jsonrpc !== "2.0" ||
          ![
            "initialize",
            "notifications/initialized",
            "notifications/cancelled",
            "ping",
            "tools/list",
            "tools/call",
          ].includes(String(rpc.method))
        ) {
          fail(response, 422, "runtime_tool_request_invalid");
          return;
        }
        // Write retries must use the original model tool-call identity, never a transient JSON-RPC id.
        if (
          rpc.method === "tools/call" &&
          (typeof requestId !== "string" || !TOOL_REQUEST_ID.test(requestId))
        ) {
          fail(response, 422, "runtime_tool_request_id_required");
          return;
        }
      }
      const authorized = await grantForRequest();
      controller.signal.throwIfAborted();
      if (closed) throw new Error("runtime_closed");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authorized.grant.runtime_grant}`,
      };
      if (
        typeof requestId === "string" &&
        (isTool ? TOOL_REQUEST_ID : REQUEST_ID).test(requestId)
      ) {
        headers["Idempotency-Key"] = requestId;
        headers["x-request-id"] = requestId;
      }
      if (isTool) {
        headers.Accept = "application/json, text/event-stream";
        for (const key of ["mcp-protocol-version", "mcp-session-id"]) {
          const value = request.headers[key];
          if (typeof value === "string" && value.length < 512) headers[key] = value;
        }
      }
      for (const key of FORWARDED_HEADERS) {
        const value = request.headers[key];
        if (typeof value === "string" && value.length < 512) headers[key] = value;
      }
      const upstream = await http(
        isTool
          ? `${authorized.origin}/api/runtime-gateway/mcp`
          : `${authorized.origin}${authorized.grant.gateway_base_url}${allowedPath.slice(3)}`,
        {
          method: "POST",
          headers,
          body,
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        },
      );
      const outputHeaders: Record<string, string> = {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      };
      for (const key of [
        "x-zhiliu-model-call-id",
        "retry-after",
        ...(isTool ? ["mcp-session-id", "mcp-protocol-version"] : []),
      ]) {
        const value = upstream.headers.get(key);
        if (value) outputHeaders[key] = value;
      }
      response.writeHead(upstream.status, outputHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            if (!response.write(result.value))
              await once(response, "drain", { signal: controller.signal });
          }
        } finally {
          reader.releaseLock();
        }
      }
      response.end();
    } catch {
      if (!response.destroyed) fail(response, 503, "runtime_gateway_unavailable");
    } finally {
      requests.delete(controller);
      response.removeListener("close", disconnected);
    }
  };
  const server = createServer((request, response) => {
    void serve(request, response);
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("runtime_broker_bind_failed");
  expectedHost = `127.0.0.1:${address.port}`;
  const profile = zhiliuManagedRuntimeProfileSchema.parse({
    version: 1,
    gatewayBaseUrl: `http://${expectedHost}/v1`,
    capabilityToken: capability,
    modelId: "zhiliu-managed",
    protocol: current.grant.profile.protocol,
    maxContextTokens: current.grant.profile.max_context_tokens,
    maxOutputTokens: current.grant.profile.max_output_tokens,
    reasoningEffort: current.grant.profile.reasoning_effort,
    platformTools: {
      url: `http://${expectedHost}/mcp`,
      capabilityToken: toolCapability,
      timeoutMs: 120000,
    },
    ...(current.grant.profile.platform_tools_write_enabled
      ? {
          approvalRequiredTools: ["mcp__zhiliu_platform__save_personal_memory"],
        }
      : {}),
  });
  let disposal: Promise<void> | undefined;
  return {
    profile,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      closed = true;
      for (const request of requests) request.abort();
      disposal = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }).then(() => options.revoke(current).catch(() => {}));
      return disposal;
    },
  };
}
