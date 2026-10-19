import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `ZCodeEnv` 是两个轴。 */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;
declare const __ZCODE_ARMS_RUM_ENDPOINT__: string;
declare const __ZCODE_TELEMETRY_REPORT_ENDPOINT__: string;
declare const __ZCODE_AUTO_UPDATE_ENABLED__: boolean;
declare const __ZHILIU_DESKTOP_ENABLED__: boolean;
declare const __ZHILIU_CLOUD_URL__: string;
declare const __ZHILIU_UPDATE_MANIFEST_URL__: string;
declare const __ZHILIU_UPDATE_INSTALL_ENABLED__: boolean;
declare const __ZHILIU_UPDATE_PUBLISHER_NAME__: string;

/** 织流 fork 身份；普通上游构建和未注入 define 的测试保持原行为。 */
export const ZHILIU_DESKTOP_ENABLED: boolean =
  typeof __ZHILIU_DESKTOP_ENABLED__ !== "undefined" ? __ZHILIU_DESKTOP_ENABLED__ : false;
/** 仅作为织流云工作台入口默认值，不替换模型、OAuth 或远控服务端点。 */
export const ZHILIU_CLOUD_URL: string =
  typeof __ZHILIU_CLOUD_URL__ !== "undefined" ? __ZHILIU_CLOUD_URL__ : "";
/** 仅构建方提供的织流更新配置；不读取运行时 feed 或用户模型/Endpoint 设置。 */
export const ZHILIU_UPDATE_MANIFEST_URL: string =
  typeof __ZHILIU_UPDATE_MANIFEST_URL__ !== "undefined" ? __ZHILIU_UPDATE_MANIFEST_URL__ : "";
export const ZHILIU_UPDATE_INSTALL_ENABLED: boolean =
  typeof __ZHILIU_UPDATE_INSTALL_ENABLED__ !== "undefined"
    ? __ZHILIU_UPDATE_INSTALL_ENABLED__
    : false;
export const ZHILIU_UPDATE_PUBLISHER_NAME: string =
  typeof __ZHILIU_UPDATE_PUBLISHER_NAME__ !== "undefined" ? __ZHILIU_UPDATE_PUBLISHER_NAME__ : "";

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `ZCODE_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeZCodeProductFlavor(
  value: string | undefined,
  zcodeEnv: ZCodeEnv,
): ZCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const ZCODE_PRODUCT_FLAVOR = normalizeZCodeProductFlavor(
  typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" ? __ZCODE_PRODUCT_FLAVOR__ : undefined,
  ZCODE_ENV,
);
export const ZCODE_APP_VERSION_ENV = "ZCODE_APP_VERSION" as const;
export const ZCODE_BUILD_COMMIT_ID_ENV = "ZCODE_BUILD_COMMIT_ID" as const;

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 ZCODE_DEBUG=9230
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;

// ── 构建期可选能力（见 docs/desktop/build-time-optional-capabilities.md），未注入时一律关闭 ──
/** ARMS RUM 上报地址；为空时不初始化 SDK，不注入远端页面。 */
export const ZCODE_ARMS_RUM_ENDPOINT: string =
  typeof __ZCODE_ARMS_RUM_ENDPOINT__ !== "undefined" ? __ZCODE_ARMS_RUM_ENDPOINT__ : "";
/** 事件上报（数仓）地址；为空时不上报。 */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT: string =
  typeof __ZCODE_TELEMETRY_REPORT_ENDPOINT__ !== "undefined"
    ? __ZCODE_TELEMETRY_REPORT_ENDPOINT__
    : "";
/** 桌面自动更新是否启用。 */
export const ZCODE_AUTO_UPDATE_ENABLED: boolean =
  typeof __ZCODE_AUTO_UPDATE_ENABLED__ !== "undefined" ? __ZCODE_AUTO_UPDATE_ENABLED__ : false;

/** 将本地运行态与编译期 ZCODE_ENV 映射为 ARMS 控制台识别的上报环境标签 */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
