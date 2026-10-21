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

/** 托管授权未就绪时关闭CLI启动边界，避免恢复个人配置或环境凭据。 */
export class DesktopInferenceUnavailableError extends Error {
  readonly code = "zhiliu_desktop_inference_unavailable";

  constructor() {
    super(
      "本地 Agent 授权尚未就绪，请先登录织流账号或稍后重试。",
    );
    this.name = "DesktopInferenceUnavailableError";
  }
}
