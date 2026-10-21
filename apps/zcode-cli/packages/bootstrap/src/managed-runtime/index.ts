import {
  ApiKeyAccessConfig, ModelConfig, ModelConfigRules, ModelOptionSpecsConfig,
  ModelPropertiesConfig, MutableAccountProviderConfigSource, ProviderApiConfig,
  ProviderConfig, ProviderConfigMap, ProviderConfigService, ProviderRegistryService,
  createFailClosedAccountProviderConfigSnapshot,
  type PersonalProviderConfigRepository, type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { NodeModelSelectionConfigRepository } from "@zcode/provider-node";
import type { ContextSourcePort, SkillPort, SkillRoot } from "@zcode/contracts";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";
import { MANAGED_MODEL_ID, MANAGED_PROVIDER_ID, MANAGED_PLACEHOLDER_KEY } from "./contract.js";

export * from "./contract.js";
export * from "./platform-tools.js";

export async function createManagedProcessProviderRuntime(profile: ZhiliuManagedRuntimeProfile) {
  const reasoningLevel = profile.reasoningEffort || "managed";
  const configuredDefaultModelSelection = {
    providerId: MANAGED_PROVIDER_ID, modelId: MANAGED_MODEL_ID,
    options: { reasoningLevel },
  };
  const provider = new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: MANAGED_PLACEHOLDER_KEY }),
    api: new ProviderApiConfig({
      type: profile.protocol === "responses" ? "openai-responses" : "openai-chat-completions",
      baseUrl: profile.gatewayBaseUrl,
    }),
    builtinModelIds: [MANAGED_MODEL_ID], personalModelIds: [], visibility: "visible",
  });
  const model = new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false, contextWindow: profile.maxContextTokens,
      // 缺省只兼容旧桌面 profile；新的 v2 图片准入仍要求显式 true。
      inputFormat: { supportsText: true, supportsImage: profile.supportsImage ?? true, supportsVideo: false,
        supportsAudio: false, supportsPdf: false },
      outputFormat: { supportsText: true }, supportsToolCall: true,
      supportsJsonSchemaOutput: true, supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: [reasoningLevel], map: "{}" },
      maxOutputTokens: { max: profile.maxOutputTokens,
        map: profile.protocol === "responses" ? '{"max_output_tokens":maxOutputTokens}' : '{"max_completion_tokens":maxOutputTokens}' },
    }),
  });
  const snapshot: ProviderConfigLayerSnapshot = Object.freeze({
    revision: "zhiliu-managed-profile-v1",
    providers: new ProviderConfigMap([[MANAGED_PROVIDER_ID, provider]]),
    models: new ModelConfigRules([{ type: "provider-model", providerId: MANAGED_PROVIDER_ID,
      modelId: MANAGED_MODEL_ID, config: model }]),
  });
  const empty: ProviderConfigLayerSnapshot = Object.freeze({
    revision: "zhiliu-managed-personal-disabled", providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(), defaultModelSelection: configuredDefaultModelSelection,
  });
  const source = (value: ProviderConfigLayerSnapshot) => ({
    read: async () => value, onDidChange: () => () => {},
  });
  const personalRepository: PersonalProviderConfigRepository = {
    ...source(empty), update: async () => { throw new Error("zhiliu_managed_models_only"); },
  };
  const configService = new ProviderConfigService({
    zcodeBuiltinSource: source(snapshot), personalRepository,
  });
  const accountSource = new MutableAccountProviderConfigSource();
  accountSource.replace(createFailClosedAccountProviderConfigSnapshot(await configService.read()), "managed-start");
  const registryService = new ProviderRegistryService({ configSource: configService, accountSource });
  await registryService.start();
  const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({ personalRepository });
  const runtime = {
    configService, registryService, personalRepository,
    start: async () => {}, onDidCheckZCodeBuiltin: () => () => {},
    dispose: () => { registryService.dispose(); configService.dispose(); },
  };
  return Object.freeze({
    runtime, snapshot: registryService.getSnapshot()!, accountSource,
    providerRuntimeHeadersPort: undefined,
    configuredDefaultModelSelection, modelSelectionConfigRepository,
    syncAccountProviderConfig: async () => { throw new Error("zhiliu_managed_models_only"); },
    dispose: () => { modelSelectionConfigRepository.dispose(); runtime.dispose(); },
  });
}

/** 平台 persona 追加到指令材料，禁止覆盖上游系统提示/工具合同。 */
export function createManagedContextSource(base: ContextSourcePort, profile: ZhiliuManagedRuntimeProfile): ContextSourcePort {
  return {
    async resolveContextSources(request, options) {
      const snapshot = await base.resolveContextSources(profile.pluginManifest
        ? { ...request, userInstructions: undefined } : request, options);
      if (!profile.instructions) return snapshot;
      const content = [snapshot.userInstructions?.content, profile.instructions].filter(Boolean).join("\n\n");
      return { ...snapshot, userInstructions: {
        filePath: "managed:agent-instructions", fileName: "平台 Agent 指令", content,
        bytesRead: Buffer.byteLength(content), sizeBytes: Buffer.byteLength(content), truncated: false,
      } };
    },
  };
}

/** 显式根传到原有 Skill loader，禁止它再发现用户/项目目录。 */
export function createManagedSkillPort(roots: SkillRoot[]): SkillPort {
  const adapter = createNodeSkillAdapter();
  return {
    discoverSkills: (request, options) => adapter.discoverSkills({ ...request, roots }, options),
    loadSkill: (request, options) => adapter.loadSkill({ ...request, roots }, options),
  };
}
