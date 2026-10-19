import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigService,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import type { NodeProviderConfigRuntime } from "@zcode/provider-node";
import {
  DesktopInferenceUnavailableError,
  rejectPersonalModelOperation,
} from "./managedModelPolicy.js";

export type ProviderConfigRuntimeBoundary = Pick<
  NodeProviderConfigRuntime,
  | "configService"
  | "personalRepository"
  | "start"
  | "resolveZCodeBuiltinActiveFilePath"
  | "refreshZCodeBuiltin"
  | "onDidCheckZCodeBuiltin"
  | "dispose"
>;

/**
 * 空目录是尚未接入平台网关的投影，不是第二份模型配置。
 * 不创建 Node 文件 Runtime，防止旧文件、迁移回调或后台轮询恢复个人供应商。
 */
export function createManagedProviderConfigRuntime(): ProviderConfigRuntimeBoundary {
  const snapshot: ProviderConfigLayerSnapshot = Object.freeze({
    revision: "zhiliu-managed-models-unavailable-v1",
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  });
  const source = {
    read: async () => snapshot,
    onDidChange: () => () => {},
  };
  const personalRepository: PersonalProviderConfigRepository = {
    ...source,
    update: rejectPersonalModelOperation,
  };
  const configService = new ProviderConfigService({
    zcodeBuiltinSource: source,
    personalRepository,
  });
  return {
    configService,
    personalRepository,
    start: async () => {
      await configService.read();
    },
    resolveZCodeBuiltinActiveFilePath: async () => {
      throw new DesktopInferenceUnavailableError();
    },
    refreshZCodeBuiltin: async () => "skipped",
    onDidCheckZCodeBuiltin: () => () => {},
    dispose: () => configService.dispose(),
  };
}
