import { createHash, randomUUID } from "node:crypto";
import { resolveWorkspaceKey, type ZhiliuManagedRuntimeProfile } from "@zcode/shared";
import { createManagedModelBroker } from "./broker.js";
import {
  runtimePortResponseSchema,
  type OwnedRuntimeGrant,
  type RuntimePrivatePort,
  type ZhiliuManagedRuntimeAuthority,
  type ManagedRuntimeTarget,
} from "./contract.js";

/** Host唯一拥有broker及其代次；业务Service只通过此合同准入。 */
export function createManagedRuntimeAuthority(options: {
  stopAgents: (target?: ManagedRuntimeTarget) => Promise<void>;
  /** 登录完成后仅重试Host已有的受限启动目标，不接收Renderer项目或模型配置。 */
  onAvailable?: () => void;
}): ZhiliuManagedRuntimeAuthority & { attach(port: RuntimePrivatePort): void } {
  let port: RuntimePrivatePort | undefined;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const active = new Map<string, Awaited<ReturnType<typeof createManagedModelBroker>>>();
  const starting = new Map<string, Promise<ZhiliuManagedRuntimeProfile>>();
  const targets = new Map<string, ManagedRuntimeTarget>();
  const workspaceGenerations = new Map<string, number>();
  const workspaceCleanup = new Map<string, Promise<void>>();
  const identityForKey = (key: string) => `local:${createHash("sha256").update(key).digest("hex")}`;
  const pending = new Map<
    string,
    {
      resolve(value: OwnedRuntimeGrant): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      workspaceIdentity: string;
    }
  >();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const requestGrant = (workspaceIdentity: string): Promise<OwnedRuntimeGrant> => {
    if (!port || disposed) return Promise.reject(new Error("请先登录织流账号"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("模型授权超时，请重试"));
      }, 20000);
      pending.set(id, { resolve, reject, timer, workspaceIdentity });
      port!.postMessage({ type: "grant", id, workspaceIdentity });
    });
  };
  const revoke = async (value: OwnedRuntimeGrant) => {
    port?.postMessage({ type: "revoke", id: randomUUID(), grantId: value.grant.grant_id });
  };
  let cleanup = Promise.resolve();
  const invalidate = () => {
    generation++;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("织流授权已断开"));
    }
    pending.clear();
    starting.clear();
    workspaceGenerations.clear();
    const scopedCleanup = [...workspaceCleanup.values()];
    workspaceCleanup.clear();
    targets.clear();
    const brokers = [...active.values()];
    active.clear();
    // 先同步关闭HTTP准入，再等CLI回收；否则旧runtime在清理等待中仍能发送新请求。
    const stopping = Promise.all(brokers.map((broker) => broker.dispose()));
    emit();
    cleanup = cleanup
      .catch(() => {})
      .then(async () => {
        await stopping;
        await Promise.allSettled(scopedCleanup);
        await options.stopAgents();
      });
    return cleanup;
  };
  const invalidateWorkspace = async (identity: string) => {
    for (const [id, entry] of pending) {
      if (entry.workspaceIdentity !== identity) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error("当前项目Agent配置已切换"));
    }
    const operations: Promise<void>[] = [];
    for (const [key, target] of targets) {
      if (identityForKey(key) !== identity) continue;
      workspaceGenerations.set(key, (workspaceGenerations.get(key) ?? 0) + 1);
      starting.delete(key);
      const broker = active.get(key);
      active.delete(key);
      const stopped = broker?.dispose();
      const previous = workspaceCleanup.get(key);
      const operation = (async () => {
        await cleanup;
        await previous?.catch(() => {});
        await stopped;
        await options.stopAgents(target);
      })();
      workspaceCleanup.set(key, operation);
      operations.push(
        operation.then(() => {
          if (workspaceCleanup.get(key) === operation) workspaceCleanup.delete(key);
        }),
      );
    }
    emit();
    await Promise.all(operations);
  };
  return {
    attach(next) {
      if (disposed) {
        next.close();
        return;
      }
      const previous = port;
      port = next;
      if (previous) {
        previous.close();
        void invalidate().catch(() => {});
      }
      next.on("message", ({ data }) => {
        if (port !== next || disposed) return;
        const result = runtimePortResponseSchema.safeParse(data);
        if (!result.success) return;
        const message = result.data;
        if (message.type === "available") {
          options.onAvailable?.();
          return;
        }
        if (message.type === "invalidate") {
          // 清理失败不确认成功，Main会保持失败屏障；同时避免事件回调产生未处理拒绝。
          void (
            message.workspaceIdentity
              ? invalidateWorkspace(message.workspaceIdentity)
              : invalidate()
          )
            .then(() => next.postMessage({ type: "invalidated", id: message.id }))
            .catch(() => {});
          return;
        }
        const request = pending.get(message.id);
        if (!request) {
          if (message.type === "grant")
            void revoke({ origin: message.origin, grant: message.grant });
          return;
        }
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.type === "grant")
          request.resolve({ origin: message.origin, grant: message.grant });
        else request.reject(new Error("织流模型授权暂不可用，请登录或重试"));
      });
      next.on("close", () => {
        if (port === next) {
          port = undefined;
          void invalidate().catch(() => {});
        }
      });
      next.start();
    },
    async resolve(target) {
      await cleanup;
      if (disposed || !port) throw new Error("请先登录织流账号");
      const key = resolveWorkspaceKey(target);
      await workspaceCleanup.get(key);
      targets.set(key, target);
      const existing = active.get(key);
      if (existing) return existing.profile;
      const inFlight = starting.get(key);
      if (inFlight) return inFlight;
      const epoch = generation;
      const workspaceEpoch = workspaceGenerations.get(key) ?? 0;
      const identity = identityForKey(key);
      const stale = () =>
        generation !== epoch || disposed || (workspaceGenerations.get(key) ?? 0) !== workspaceEpoch;
      const operation = (async () => {
        const initial = await requestGrant(identity);
        if (stale()) {
          await revoke(initial);
          throw new Error("织流授权已断开");
        }
        const broker = await createManagedModelBroker({
          initial,
          renew: () => requestGrant(identity),
          revoke,
        });
        if (stale()) {
          await broker.dispose();
          throw new Error("织流授权已断开");
        }
        active.set(key, broker);
        emit();
        return broker.profile;
      })();
      starting.set(key, operation);
      try {
        return await operation;
      } finally {
        if (starting.get(key) === operation) starting.delete(key);
      }
    },
    // 实测同 Host 的 one=low/two=high 曾被最后一次 resolve 的全局 profile 串成 high。
    // broker map 才是每个工作区的授权 owner；无目标读取不得猜测一个活跃项目。
    readProfile: (target) =>
      target ? active.get(resolveWorkspaceKey(target))?.profile : undefined,
    onDidChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate,
    invalidateWorkspace,
    async dispose() {
      disposed = true;
      await invalidate();
      port?.close();
      port = undefined;
      listeners.clear();
    },
  };
}
