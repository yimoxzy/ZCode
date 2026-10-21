import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigService,
  parseProviderConfigMap,
  parseZCodeBuiltinModelConfigRules,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import type { NodeProviderConfigRuntime } from "@zcode/provider-node";
import {
  DesktopInferenceUnavailableError,
  rejectPersonalModelOperation,
} from "./managedModelPolicy.js";
import type { ZhiliuManagedRuntimeAuthority } from "../zhiliu-runtime/contract.js";

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
export function createManagedProviderConfigRuntime(
  authority?: Pick<ZhiliuManagedRuntimeAuthority, "readProfile" | "onDidChange">,
): ProviderConfigRuntimeBoundary {
  const snapshot: ProviderConfigLayerSnapshot = Object.freeze({
    revision: "zhiliu-managed-models-unavailable-v1",
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  });
  const source = {
    read: async (): Promise<ProviderConfigLayerSnapshot> => {
      const profile = authority?.readProfile();
      if (!profile) return snapshot;
      return {
        revision: `managed:${profile.protocol}:${profile.maxContextTokens}:${profile.maxOutputTokens}:${profile.reasoningEffort ?? "default"}`,
        // UI目录只有非秘密元数据；真实broker地址/capability仅走CLI可信首帧。
        providers: parseProviderConfigMap([
          {
            providerId: "zhiliu-managed",
            providerName: "织流托管模型",
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "managed-runtime-only" },
              api: {
                type:
                  profile.protocol === "responses" ? "openai-responses" : "openai-chat-completions",
                baseUrl: "http://127.0.0.1:1/v1",
              },
              builtinModelIds: ["zhiliu-managed"],
              visibility: "visible",
            },
          },
        ]),
        models: parseZCodeBuiltinModelConfigRules({
          modelRules: [
            {
              modelMatch: "zhiliu-managed",
              config: {
                enabled: true,
                properties: {
                  contextWindow: profile.maxContextTokens,
                  requiresMfjsToolSchema: false,
                  inputFormat: {
                    supportsText: true,
                    supportsImage: false,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: true },
                  supportsToolCall: true,
                  supportsJsonSchemaOutput: true,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                },
                optionSpecs: {
                  reasoningLevel: { values: [profile.reasoningEffort ?? "managed"], map: "{}" },
                  maxOutputTokens: {
                    max: profile.maxOutputTokens,
                    map:
                      profile.protocol === "responses"
                        ? '{"max_output_tokens":maxOutputTokens}'
                        : '{"max_tokens":maxOutputTokens}',
                  },
                },
              },
            },
          ],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        }),
      };
    },
    onDidChange: (listener: (reason: string) => void) =>
      authority?.onDidChange(() => listener("managed-runtime-profile")) ?? (() => {}),
  };
  const personalRepository: PersonalProviderConfigRepository = {
    read: async () => snapshot,
    onDidChange: () => () => {},
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
      // managed CLI完全跳过文件loader；此路径只为保留上游装配接口，永不写凭据。
      throw new DesktopInferenceUnavailableError();
    },
    refreshZCodeBuiltin: async () => "skipped",
    onDidCheckZCodeBuiltin: () => () => {},
    dispose: () => configService.dispose(),
  };
}
