// Model factory - creates model adapter with config

import {
  createModelRequestSecurityState,
  AiSdkModelAdapter,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "@zcode/adapters/model";
import type { Logger, ModelStatusSink } from "@zcode/contracts";
import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";

interface CreateModelAdapterBaseOptions {
  managedRuntimeProfile?: ZhiliuManagedRuntimeProfile;
  env?: EnvRecord;
  logger?: Logger;
  modelIoDir?: string;
  modelIoFullRetentionEnabled?: boolean;
  streamIdleTimeoutMs?: number;
  statusSink?: ModelStatusSink;
}

export type CreateModelAdapterOptions = CreateModelAdapterBaseOptions & {
  executionConfig: AiSdkModelExecutionConfig;
};

// 可复用资源由进程拥有，每个 execution 保留自己的请求状态。
const processRequestSecurityState = createModelRequestSecurityState();

export function createModelAdapter(options: CreateModelAdapterOptions): AiSdkModelAdapter {
  if (!options.executionConfig) {
    throw new Error("createModelAdapter requires executionConfig");
  }
  return new AiSdkModelAdapter({
    ...options.executionConfig,
    ...(options.managedRuntimeProfile ? {
      endpointRoutingPort: undefined, network: undefined, singleAttempt: true,
      retry: { maxAttempts: 1 },
    } : {}),
    requestSecurityState: options.managedRuntimeProfile
      ? createModelRequestSecurityState(options.managedRuntimeProfile) : processRequestSecurityState,
    debugDir: options.managedRuntimeProfile ? undefined : options.modelIoDir,
    env: options.managedRuntimeProfile ? {} : options.env,
    logger: options.logger,
    modelIoFullRetentionEnabled: options.managedRuntimeProfile ? false : options.modelIoFullRetentionEnabled,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    statusSink: options.statusSink,
  });
}
