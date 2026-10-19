import { ZCODE_ARMS_RUM_ENDPOINT, ZHILIU_DESKTOP_ENABLED } from "@zcode/shared";

/** SDK 的 enable=false 不会跳过其 session/preload 副作用；调用 init 前必须判断此位。 */
export const ARMS_TELEMETRY_ENABLED =
  !ZHILIU_DESKTOP_ENABLED && ZCODE_ARMS_RUM_ENDPOINT.trim().length > 0;
