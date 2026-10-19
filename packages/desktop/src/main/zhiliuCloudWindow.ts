import { BrowserWindow, session } from "electron";
import type { DownloadItem, Event, WebContents } from "electron";
import {
  buildZhiliuCloudWebPreferences,
  isZhiliuCloudNavigationAllowed,
  resolveZhiliuCloudTarget,
  safeZhiliuCloudDownloadName,
} from "./zhiliuCloudPolicy.js";

export interface OpenZhiliuCloudWindowOptions {
  cloudUrl: string | undefined;
  iconPath?: string;
  entry?: "feedback" | "devices";
  authorizationId?: string;
  appVersion?: string;
  sessionTicket?: string;
  sessionDestination?: string;
  parent?: BrowserWindow | null;
  logger?: { warn: (...args: unknown[]) => void };
}

let cloudWindow: BrowserWindow | null = null;
let cloudOrigin: string | null = null;
const hardenedPartitions = new Set<string>();

/** workspace 窗口枚举应排除此窗口；应用退出仍需关闭它。 */
export function isZhiliuCloudWindow(win: BrowserWindow): boolean {
  return cloudWindow === win;
}

export function hasZhiliuCloudWindow(origin: string): boolean {
  return cloudOrigin === origin && cloudWindow !== null && !cloudWindow.isDestroyed();
}

/** 账号退出时销毁远端会话，关闭窗口后清该 origin partition，保留本地项目数据。 */
export async function clearZhiliuCloudSession(origin: string): Promise<void> {
  const target = resolveZhiliuCloudTarget(origin);
  if (cloudOrigin === origin && cloudWindow && !cloudWindow.isDestroyed()) cloudWindow.destroy();
  await session.fromPartition(target.partition).clearStorageData();
}

function configureZhiliuCloudSession(partition: string) {
  const cloudSession = session.fromPartition(partition);
  if (!hardenedPartitions.has(partition)) {
    cloudSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    cloudSession.setPermissionCheckHandler(() => false);
    cloudSession.setDevicePermissionHandler(() => false);
    cloudSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    hardenedPartitions.add(partition);
  }
  return cloudSession;
}

/**
 * 云页面使用原有 SaaS 登录和接口；此处只拥有窗口生命周期，不拥有身份、任务或模型。
 * 不能给该远端窗口复用 desktop preload，否则同源 XSS 会获得本机任意操作能力。
 */
export async function openZhiliuCloudWindow(
  options: OpenZhiliuCloudWindowOptions,
): Promise<BrowserWindow> {
  const target = resolveZhiliuCloudTarget(options.cloudUrl);
  if (options.sessionTicket) {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(options.sessionTicket))
      throw new Error("Invalid account ticket");
    const destination = options.sessionDestination ?? "/agent";
    if (
      destination !== "/agent" &&
      destination !== "/feedback" &&
      !/^\/settings\/devices\?connect=[a-f0-9-]{36}$/iu.test(destination)
    )
      throw new Error("Invalid account destination");
    const loginUrl = new URL(target.url);
    loginUrl.hash = `/desktop-session?${new URLSearchParams({ ticket: options.sessionTicket, next: destination })}`;
    target.url = loginUrl.href;
  }
  if (!options.sessionTicket && options.entry === "devices") {
    if (!options.authorizationId || !/^[a-f0-9-]{36}$/iu.test(options.authorizationId))
      throw new Error("Invalid device authorization");
    const deviceUrl = new URL(target.url);
    deviceUrl.hash = `/settings/devices?connect=${options.authorizationId}`;
    target.url = deviceUrl.href;
  }
  if (!options.sessionTicket && options.entry === "feedback") {
    const feedbackUrl = new URL(target.url);
    const query = new URLSearchParams({ source: "desktop" });
    if (options.appVersion && /^[\w.+-]{1,64}$/u.test(options.appVersion)) {
      query.set("app_version", options.appVersion);
    }
    feedbackUrl.hash = `/feedback?${query}`;
    target.url = feedbackUrl.href;
  }
  if (cloudWindow && !cloudWindow.isDestroyed()) {
    if (cloudOrigin === target.origin) {
      // 只有明确反馈动作才改 hash；普通云入口仍只聚焦，避免重载登录与草稿。
      if (options.sessionTicket || options.entry === "feedback" || options.entry === "devices") {
        try {
          await cloudWindow.loadURL(target.url);
        } catch {
          throw new Error("无法打开织流问题反馈，请检查网络后重试。");
        }
      }
      if (cloudWindow.isMinimized()) cloudWindow.restore();
      cloudWindow.show();
      cloudWindow.focus();
      return cloudWindow;
    }
    cloudWindow.destroy();
  }

  const cloudSession = configureZhiliuCloudSession(target.partition);
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: "织流 · 云 Agent",
    ...(options.iconPath ? { icon: options.iconPath } : {}),
    show: false,
    autoHideMenuBar: true,
    ...(options.parent && !options.parent.isDestroyed() ? { parent: options.parent } : {}),
    webPreferences: buildZhiliuCloudWebPreferences(target),
  });
  cloudWindow = win;
  cloudOrigin = target.origin;
  win.removeMenu();

  const blockedNavigation = (event: { preventDefault(): void }, url: string) => {
    if (!isZhiliuCloudNavigationAllowed(url, target.origin)) {
      event.preventDefault();
      options.logger?.warn("[zhiliu-cloud] blocked navigation outside configured origin");
    }
  };
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", blockedNavigation);
  win.webContents.on("will-redirect", blockedNavigation);
  win.webContents.on("will-frame-navigate", (event) => {
    if (!isZhiliuCloudNavigationAllowed(event.url, target.origin, !event.isMainFrame)) {
      event.preventDefault();
    }
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.on("page-title-updated", (event) => event.preventDefault());

  const downloadListener = (event: Event, item: DownloadItem, contents: WebContents) => {
    if (!contents || contents.id !== win.webContents.id) {
      event.preventDefault();
      return;
    }
    if (!isZhiliuCloudNavigationAllowed(item.getURL(), target.origin, true)) {
      event.preventDefault();
      options.logger?.warn("[zhiliu-cloud] blocked download outside configured origin");
      return;
    }
    // 不调用 setSavePath：必须让用户通过系统另存为对话框选择位置。
    item.setSaveDialogOptions({
      title: "保存织流文件",
      defaultPath: safeZhiliuCloudDownloadName(item.getFilename()),
    });
  };
  cloudSession.on("will-download", downloadListener);
  win.once("closed", () => {
    cloudSession.removeListener("will-download", downloadListener);
    if (cloudWindow === win) {
      cloudWindow = null;
      cloudOrigin = null;
    }
  });

  try {
    await win.loadURL(target.url);
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
    return win;
  } catch {
    if (!win.isDestroyed()) win.destroy();
    // 原始 loadURL 错误可能包含登录 hash 或敏感 query，使用固定错误留给入口展示。
    throw new Error("无法打开织流云 Agent，请检查服务地址或网络后重试。");
  }
}
