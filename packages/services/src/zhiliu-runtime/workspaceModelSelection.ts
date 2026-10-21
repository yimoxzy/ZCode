import { z } from "zod";
import {
  modelSelectionSchema,
  resolveWorkspaceKey,
  zhiliuRuntimeWorkspaceSchema,
} from "@zcode/shared";
import type {
  IModelSelectionService,
  ModelSelectionViewInput,
  ModelSelectionView,
} from "../model-provider/providerFacadeServices.js";
import { createManagedProviderConfigRuntime } from "../zhiliu/managedProviderConfigRuntime.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "../model-provider/providerRuntime.js";
import type { ZhiliuManagedRuntimeAuthority, ManagedRuntimeTarget } from "./contract.js";

const inputSchema = z
  .object({
    selection: modelSelectionSchema.nullable(),
    workspace: zhiliuRuntimeWorkspaceSchema.optional(),
  })
  .strict();
const MANAGED_ALIAS = "zhiliu-managed";

/** Derived catalogues only. The authority's existing brokers remain the sole profile owner. */
export function createManagedWorkspaceModelSelectionService(
  authority: ZhiliuManagedRuntimeAuthority,
): IModelSelectionService & { dispose(): void } {
  let revision = 0;
  let disposed = false;
  const projections = new Map<string, { target: ManagedRuntimeTarget; runtime: ProviderRuntime }>();
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const empty = (): ModelSelectionView => ({ revision, providers: [] });
  const unsubscribe = authority.onDidChange(() => {
    revision++;
    for (const [key, entry] of projections) {
      if (!authority.readProfile(entry.target)) {
        projections.delete(key);
        entry.runtime.dispose();
      }
    }
    // 全局事件只能作失效信号；各项目必须携带自己的 target 重读，不能共享 ready 快照。
    for (const listener of listeners) listener(empty());
  });
  const projectionFor = (target: ManagedRuntimeTarget) => {
    const key = resolveWorkspaceKey(target);
    const existing = projections.get(key);
    if (existing) return existing.runtime;
    const boundAuthority = {
      readProfile: () => authority.readProfile(target),
      onDidChange: authority.onDidChange,
    };
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime: createManagedProviderConfigRuntime(boundAuthority),
      modelSelectionConfiguredDefaultSource: {
        read: async () => {
          const profile = authority.readProfile(target);
          return profile
            ? {
                providerId: MANAGED_ALIAS,
                modelId: MANAGED_ALIAS,
                options: {
                  reasoningLevel: profile.reasoningEffort ?? "managed",
                },
              }
            : undefined;
        },
        onDidChange: authority.onDidChange,
      },
    });
    projections.set(key, { target, runtime });
    return runtime;
  };
  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    async getView(input?: ModelSelectionViewInput) {
      if (disposed) throw new Error("ModelSelectionService 已 dispose");
      const parsed = input === undefined ? undefined : inputSchema.parse(input);
      if (!parsed?.workspace) return empty();
      const target = parsed.workspace;
      const profile = await authority.resolve(target);
      if (disposed || authority.readProfile(target) !== profile)
        throw new Error("当前项目模型授权已失效");
      const runtime = projectionFor(target);
      await runtime.start();
      await runtime.registryService.refresh("managed-workspace-view");
      const view = await runtime.modelSelection.getView({
        selection: parsed.selection,
      });
      if (disposed || authority.readProfile(target) !== profile)
        throw new Error("当前项目模型授权已失效");
      return { ...view, revision };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
      for (const entry of projections.values()) entry.runtime.dispose();
      projections.clear();
    },
  };
}
