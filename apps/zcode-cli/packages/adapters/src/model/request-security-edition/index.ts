import type { ModelRequestSecurityState } from "../request-security.js";
import { zhiliuManagedRuntimeProfileSchema, type ZhiliuManagedRuntimeProfile } from "@zcode/shared";
import { withoutNetworkCapture } from "@zcode/shared/node";

export function createModelRequestSecurityState(profile?: ZhiliuManagedRuntimeProfile): ModelRequestSecurityState {
  if (profile) {
    if (!zhiliuManagedRuntimeProfileSchema.safeParse(profile).success) {
      throw new Error("zhiliu_managed_profile_rejected");
    }
    const endpoint = `${profile.gatewayBaseUrl}/${profile.protocol === "responses" ? "responses" : "chat/completions"}`;
    const capability = profile.capabilityToken;
    return {
      createExecution: () => ({
        take: () => [],
        protectTransport: () => async (input, init) => {
          const request = new Request(input, init);
          // 可信首帧的目标在最后网络边界再次校验；请求配置、插件和 SDK 不得改写它。
          if (request.url !== endpoint || request.method !== "POST") {
            throw new Error("zhiliu_managed_transport_target_rejected");
          }
          const body = await request.clone().json() as Record<string, unknown>;
          if (body.model !== "zhiliu-managed") throw new Error("zhiliu_managed_model_rejected");
          if (profile.protocol === "responses") {
            if (body.previous_response_id || body.background === true) throw new Error("zhiliu_managed_stateful_request_rejected");
            body.store = false;
          }
          const headers = new Headers(request.headers);
          for (const name of Array.from(headers.keys())) {
            if (/authorization|api[-_]?key|cookie|capability/i.test(name)) headers.delete(name);
          }
          headers.set("authorization", `Bearer ${capability}`);
          headers.set("content-type", "application/json");
          if (!headers.get("idempotency-key")) headers.set("idempotency-key", headers.get("x-request-id") || crypto.randomUUID());
          // 绕过用户代理/endpoint routing adapter；仅向显式回环 broker 发送，不跟随重定向。
          const response = await withoutNetworkCapture(() => globalThis.fetch(endpoint, {
            method: "POST", body: JSON.stringify(body), headers, signal: request.signal, redirect: "error",
          }));
          return response;
        },
      }),
    };
  }
  return {
    createExecution: () => ({
      protectTransport: ({ transport }) => transport,
      take: () => [],
    }),
  };
}
