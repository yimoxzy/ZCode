/* eslint-disable no-control-regex -- 更新来源是信任边界，显式拒绝 URL 控制字符。 */
export interface ZhiliuUpdatePolicy {
  manifestUrl: string | null;
  installEnabled: boolean;
  publisherName: string | null;
}

export interface ZhiliuUpdateConfiguration {
  manifestUrl?: string;
  installEnabled?: boolean;
  publisherName?: string;
}

function validateUpdateUrl(value: string): URL {
  if (/[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new Error("织流更新地址包含非法字符");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("织流更新地址必须是有效的 HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#") ||
    url.hostname === "z.ai" ||
    url.hostname.endsWith(".z.ai")
  ) {
    throw new Error("织流更新地址必须使用自有 HTTPS 服务且不包含凭据、query 或 fragment");
  }
  return url;
}

/** 只接受构建方传入的固定配置，不读取用户设置、运行时 env 或上游 Endpoint。 */
export function resolveZhiliuUpdatePolicy(
  configuration: ZhiliuUpdateConfiguration,
  platform: NodeJS.Platform = process.platform,
): ZhiliuUpdatePolicy {
  const manifestUrl = configuration.manifestUrl?.trim();
  const publisherName = configuration.publisherName?.trim() || null;
  if (publisherName && (publisherName.length > 256 || /[\r\n]/u.test(publisherName))) {
    throw new Error("织流更新发布者名称无效");
  }
  if (!manifestUrl) {
    if (configuration.installEnabled) throw new Error("启用织流更新安装前必须配置更新服务");
    return { manifestUrl: null, installEnabled: false, publisherName };
  }
  const normalizedUrl = validateUpdateUrl(manifestUrl).href;
  if (configuration.installEnabled && platform === "win32" && !publisherName) {
    throw new Error("Windows 织流更新安装必须配置固定签名发布者");
  }
  return {
    manifestUrl: normalizedUrl,
    installEnabled: configuration.installEnabled === true,
    publisherName,
  };
}

export function resolveZhiliuUpdateBuildPolicy(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): ZhiliuUpdatePolicy {
  return resolveZhiliuUpdatePolicy(
    {
      manifestUrl: env.ZHILIU_UPDATE_MANIFEST_URL,
      installEnabled: ["1", "true", "yes"].includes(
        env.ZHILIU_UPDATE_INSTALL_ENABLED?.trim().toLowerCase() ?? "",
      ),
      publisherName: env.ZHILIU_UPDATE_PUBLISHER_NAME,
    },
    platform,
  );
}

export function buildZhiliuUpdatePublishConfiguration(policy: ZhiliuUpdatePolicy) {
  if (!policy.manifestUrl) return null;
  return {
    provider: "generic" as const,
    url: new URL(".", policy.manifestUrl).href,
    useMultipleRangeRequest: false,
    ...(policy.publisherName ? { publisherName: [policy.publisherName] } : {}),
  };
}

export function assertZhiliuUpdateArtifact(
  path: string,
  sha512: string | undefined,
  manifestUrl: string,
): void {
  const base = validateUpdateUrl(manifestUrl);
  // 相对地址先检查原文，禁止 URL 解析将反斜杠或控制字符规范化后掩盖非法输入。
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) throw new Error("织流更新文件地址无效");
  const url = validateUpdateUrl(new URL(path, new URL("/", base)).href);
  if (url.origin !== base.origin) throw new Error("织流更新文件必须来自更新服务同一来源");
  if (!sha512 || !/^[A-Za-z0-9+/]{86}==$/u.test(sha512)) {
    throw new Error("织流更新文件必须提供有效的 SHA-512 校验和");
  }
}

/** 同时用于首次请求与每次重定向；更新专用 Electron session 不得访问其他来源。 */
export function isZhiliuUpdateRequestAllowed(url: string, manifestUrl: string): boolean {
  try {
    const base = validateUpdateUrl(manifestUrl);
    if (/[\u0000-\u001f\u007f\\]/u.test(url)) return false;
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      target.hash
    )
      return false;
    if (target.pathname !== base.pathname) return !target.search;
    const allowedParameters = new Set(["platform", "device_mid", "channel"]);
    for (const key of target.searchParams.keys()) {
      if (!allowedParameters.has(key) || target.searchParams.getAll(key).length !== 1) return false;
    }
    const channel = target.searchParams.get("channel");
    return channel === null || channel === "1" || channel === "3";
  } catch {
    return false;
  }
}

/** NSIS 在 publisherName 缺失时会跳过签名验证，所以安装前必须核实固定发布者。 */
export function assertZhiliuUpdateSigningConfiguration(
  policy: ZhiliuUpdatePolicy,
  configuration: unknown,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!policy.installEnabled || platform !== "win32") return;
  if (!policy.manifestUrl || !policy.publisherName) throw new Error("织流更新签名配置缺失");
  const source = configuration as {
    publisherName?: unknown;
    url?: unknown;
    updaterCacheDirName?: unknown;
  } | null;
  const publishers = Array.isArray(source?.publisherName)
    ? source.publisherName
    : [source?.publisherName];
  if (publishers.length !== 1 || publishers[0] !== policy.publisherName) {
    throw new Error("织流更新固定签名发布者与安装配置不匹配");
  }
  if (source?.url !== new URL(".", policy.manifestUrl).href) {
    throw new Error("织流更新安装配置不属于当前更新服务");
  }
  if (source?.updaterCacheDirName !== "zhiliu-desktop-updater") {
    throw new Error("织流更新必须使用独立的安装缓存目录");
  }
}
