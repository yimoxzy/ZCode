/** 可跨 RPC 作为稳定错误码识别，区别于无网络或未登录。 */
export class OfficialCloudDisabledError extends Error {
  readonly code = "zhiliu_official_cloud_disabled";
  constructor() {
    super("zhiliu_official_cloud_disabled");
    this.name = "OfficialCloudDisabledError";
  }
}

export async function rejectOfficialCloudOperation(): Promise<never> {
  throw new OfficialCloudDisabledError();
}
