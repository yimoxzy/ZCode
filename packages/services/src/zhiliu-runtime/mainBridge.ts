import { randomUUID } from "node:crypto";
import {
  runtimePortRequestSchema,
  type OwnedRuntimeGrant,
  type RuntimePrivatePort,
} from "./contract.js";

/** Main独占dl_；此桥只接受可信UtilityProcess的工作区授权意图。 */
export function attachManagedRuntimeMainBridge(
  port: RuntimePrivatePort,
  options: {
    authorize(workspaceIdentity: string): Promise<OwnedRuntimeGrant>;
    revoke(grantId: string): Promise<void>;
  },
) {
  let closed = false;
  const waiting = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  port.on("message", ({ data }) => {
    if (closed) return;
    const parsed = runtimePortRequestSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "invalidated") {
      const result = waiting.get(message.id);
      if (result) {
        waiting.delete(message.id);
        clearTimeout(result.timer);
        result.resolve();
      }
      return;
    }
    if (message.type === "revoke") {
      void options
        .revoke(message.grantId)
        .catch(() => {})
        .then(() => {
          if (!closed) port.postMessage({ type: "revoked", id: message.id });
        });
      return;
    }
    void options.authorize(message.workspaceIdentity).then(
      async (value) => {
        if (closed) {
          await options.revoke(value.grant.grant_id).catch(() => {});
          return;
        }
        port.postMessage({ type: "grant", id: message.id, ...value });
      },
      () => {
        if (!closed) port.postMessage({ type: "error", id: message.id });
      },
    );
  });
  const close = () => {
    closed = true;
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Host连接已关闭"));
    }
    waiting.clear();
  };
  port.on("close", close);
  port.start();
  return {
    available() {
      if (!closed) port.postMessage({ type: "available", id: randomUUID() });
    },
    invalidate(workspaceIdentity?: string): Promise<void> {
      if (closed) return Promise.resolve();
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("本地Agent清理未完成"));
        }, 20000);
        waiting.set(id, { resolve, reject, timer });
        port.postMessage({
          type: "invalidate",
          id,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
      });
    },
    dispose() {
      close();
      port.close();
    },
  };
}
