/* eslint-disable no-control-regex -- 显式拦截 URL 和下载文件名的控制字符，避免日志与路径混淆。 */
import { createHash } from "node:crypto";
import type { WebPreferences } from "electron";

export interface ZhiliuCloudTarget {
  url: string;
  origin: string;
  partition: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 可信 Main 配置的唯一入口；不接受网页提供的地址或登录参数。 */
export function resolveZhiliuCloudTarget(rawUrl: string | undefined): ZhiliuCloudTarget {
  const value = rawUrl?.trim();
  if (!value || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new Error("ZHILIU_CLOUD_URL must be a valid HTTPS URL or HTTP loopback URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ZHILIU_CLOUD_URL must be a valid HTTPS URL or HTTP loopback URL");
  }
  const secure = parsed.protocol === "https:";
  const loopback = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if ((!secure && !loopback) || parsed.username || parsed.password || parsed.search) {
    throw new Error(
      "ZHILIU_CLOUD_URL must use HTTPS or HTTP loopback without credentials or query",
    );
  }
  if (!parsed.hash) parsed.hash = "/agent";
  return {
    url: parsed.href,
    origin: parsed.origin,
    partition: `persist:zhiliu-cloud-${createHash("sha256").update(parsed.origin).digest("hex").slice(0, 20)}`,
  };
}

export function isZhiliuCloudNavigationAllowed(
  url: string,
  origin: string,
  allowBlob = false,
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password &&
      (parsed.protocol === "https:" ||
        parsed.protocol === "http:" ||
        (allowBlob && parsed.protocol === "blob:"))
    );
  } catch {
    return false;
  }
}

export function buildZhiliuCloudWebPreferences(target: ZhiliuCloudTarget): WebPreferences {
  return {
    partition: target.partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    plugins: false,
  };
}

/** 下载文件名只是系统另存为对话框的建议值，不允许网页指定路径。 */
export function safeZhiliuCloudDownloadName(filename: string): string {
  const leaf = filename.split(/[\\/]/u).pop() ?? "";
  const safe = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, "_").replace(/[. ]+$/u, "");
  if (!safe || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe)) {
    return "zhiliu-download";
  }
  return safe.slice(0, 180);
}
