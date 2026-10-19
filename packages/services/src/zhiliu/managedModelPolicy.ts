/** 织流模型由 SaaS 统一管理；此错误不可通过个人 Key 配置消除。 */
export class ManagedModelsOnlyError extends Error {
  readonly code = "zhiliu_managed_models_only";

  constructor() {
    super(
      "织流模型由平台统一管理，请登录织流账号使用；客户端不支持配置个人模型、API Key 或上游地址。",
    );
    this.name = "ManagedModelsOnlyError";
  }
}

export async function rejectPersonalModelOperation(): Promise<never> {
  throw new ManagedModelsOnlyError();
}

/** 网关尚未接入时关闭整个 CLI 启动边界，避免初始化时恢复旧配置或环境变量凭据。 */
export class DesktopInferenceUnavailableError extends Error {
  readonly code = "zhiliu_desktop_inference_unavailable";

  constructor() {
    super(
      "本地项目尚未接入织流账号授权与积分计费，暂不启动本地 Agent。请登录云 Agent 使用平台模型。",
    );
    this.name = "DesktopInferenceUnavailableError";
  }
}
