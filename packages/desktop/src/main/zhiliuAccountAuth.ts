import { app, dialog, safeStorage, type MessageBoxOptions } from "electron";
import { join } from "node:path";
import { resolveZhiliuCloudTarget } from "./zhiliuCloudPolicy.js";
import {
  beginZhiliuAccountAuthorization,
  createZhiliuAccountBootstrap,
  fetchZhiliuAccountSession,
  revokeZhiliuAccount,
  ZhiliuAccountHttpError,
  ZhiliuAccountSecureStore,
  type StoredZhiliuAccount,
  type ZhiliuAccountSession,
  type ZhiliuAccountStore,
} from "./zhiliuAccountAuthorization.js";

export interface ZhiliuAccountStatus {
  phase: "logged_out" | "authorizing" | "authenticated" | "unavailable";
  user?: ZhiliuAccountSession["user"];
  space?: ZhiliuAccountSession["space"];
  expiresAt?: string;
  userCode?: string;
  message: string;
}
export interface ZhiliuAccountAuthOptions {
  cloudUrl: () => string | undefined;
  openExternal: (url: string) => Promise<void>;
  pauseComputer: () => void | Promise<void>;
  disconnectComputer: () => Promise<void>;
  clearCloudSession: (origin: string) => Promise<void>;
  openCloudSession?: (ticket: string, origin: string) => Promise<void>;
  showMessageBox?: (options: MessageBoxOptions) => Promise<{ response: number }>;
  store?: ZhiliuAccountStore;
  http?: typeof fetch;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
function waitForPoll(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(stop, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
  });
}
const loggedOut = (message = "尚未登录织流"): ZhiliuAccountStatus => ({
  phase: "logged_out",
  message,
});
const temporaryFailure = (error: unknown) =>
  error instanceof ZhiliuAccountHttpError
    ? error.status >= 500 || error.status === 429
    : error instanceof TypeError ||
      (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));

/**
 * Main 拥有账号、凭据队列及授权代次。UI 只读投影，Host 独立取得限权工具 grant。
 * 云窗创建与清理串行，防止退出时迟到的 loadURL 在清理之后重新打开登录窗口。
 */
export function createZhiliuAccountAuth(options: ZhiliuAccountAuthOptions) {
  const http = options.http ?? fetch,
    now = options.now ?? Date.now;
  const showMessageBox = options.showMessageBox ?? ((value) => dialog.showMessageBox(value));
  const wait = options.wait ?? waitForPoll;
  const store =
    options.store ??
    new ZhiliuAccountSecureStore(join(app.getPath("userData"), "account-credentials"), safeStorage);
  let generation = 0,
    current: StoredZhiliuAccount | null = null;
  let projection = loggedOut(),
    validatedAt = 0,
    initialized = false;
  let restorePromise: Promise<void> | undefined;
  let loginPromise: Promise<ZhiliuAccountStatus> | undefined;
  let logoutPromise: Promise<{ confirmed: boolean; remoteRevoked: boolean }> | undefined;
  let validationPromise: Promise<ZhiliuAccountStatus> | undefined;
  let invalidationCleanup: Promise<void> | undefined;
  let browserUrl: string | undefined;
  let pollAbort = new AbortController();
  let credentialOperation = Promise.resolve(),
    cloudOperation = Promise.resolve();
  const withCredentials = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = credentialOperation.then(operation);
    credentialOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const withCloud = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = cloudOperation.then(operation);
    cloudOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const status = (): ZhiliuAccountStatus => structuredClone(projection);
  const authenticated = (session: ZhiliuAccountSession) => {
    projection = {
      phase: "authenticated",
      user: session.user,
      space: session.space,
      expiresAt: session.expires_at,
      message: "已登录织流，模型由平台统一管理",
    };
    validatedAt = now();
    return status();
  };
  const revokeQuietly = async (record: StoredZhiliuAccount) => {
    await revokeZhiliuAccount(record, http).catch(() => undefined);
  };
  const discardReceived = async (record: StoredZhiliuAccount) => {
    // 取消可以发生在磁盘保存已开始之后；仅撤远端 grant 在离线时不足以防止重启恢复。
    // 按 token 比较并串行删除，不能删除取消后新登录已经保存的另一份凭据。
    await withCredentials(async () => {
      const saved = await store.read(record.origin);
      if (saved?.credential.login_token === record.credential.login_token)
        await store.remove(record.origin);
    });
    await revokeQuietly(record);
  };
  const initialize = async () => {
    if (initialized) return;
    if (restorePromise) return restorePromise;
    const epoch = generation;
    restorePromise = (async () => {
      try {
        const origin = resolveZhiliuCloudTarget(options.cloudUrl()).origin;
        const saved = await withCredentials(() => store.read(origin));
        if (generation !== epoch) return;
        if (saved && Date.parse(saved.credential.expires_at) > now()) current = saved;
        else if (saved) await withCredentials(() => store.remove(origin));
      } catch {
        if (generation === epoch)
          projection = { phase: "unavailable", message: "无法读取账号，请检查系统安全存储后重试" };
      } finally {
        if (generation === epoch) initialized = true;
        restorePromise = undefined;
      }
    })();
    return restorePromise;
  };
  const invalidate = (record: StoredZhiliuAccount, epoch: number): Promise<void> => {
    if (generation !== epoch || current !== record) return Promise.resolve();
    generation++;
    validationPromise = undefined;
    pollAbort.abort();
    current = null;
    projection = loggedOut("登录已失效，请重新授权");
    // 单次写删串行不能覆盖断开 Host 的网络等待；先发布整次清理屏障，
    // 防止这段等待内的新登录被旧 remove/clear 删除凭据或关闭云窗。
    const cleanup = Promise.resolve().then(async () => {
      await options.pauseComputer();
      await options.disconnectComputer().catch(() => undefined);
      await withCredentials(() => store.remove(record.origin));
      await withCloud(() => options.clearCloudSession(record.origin));
    });
    invalidationCleanup = cleanup;
    void cleanup.then(
      () => {
        if (invalidationCleanup === cleanup) invalidationCleanup = undefined;
      },
      () => undefined,
    );
    return cleanup;
  };
  const validate = async (force: boolean): Promise<ZhiliuAccountStatus> => {
    await initialize();
    if (projection.phase === "authorizing" || !current) return status();
    if (
      !force &&
      projection.phase === "authenticated" &&
      now() - validatedAt < 60000 &&
      Date.parse(projection.expiresAt ?? current.credential.expires_at) > now()
    )
      return status();
    if (validationPromise) return validationPromise;
    const record = current,
      epoch = generation;
    let pendingValidation!: Promise<ZhiliuAccountStatus>;
    pendingValidation = (async () => {
      try {
        const session = await fetchZhiliuAccountSession(record, http, now);
        if (generation !== epoch || current !== record) return status();
        return authenticated(session);
      } catch (error) {
        if (generation !== epoch || current !== record) return status();
        if (temporaryFailure(error)) {
          projection = { phase: "unavailable", message: "暂时无法验证账号，请检查网络后重试" };
        } else await invalidate(record, epoch);
        return status();
      } finally {
        if (validationPromise === pendingValidation) validationPromise = undefined;
      }
    })();
    validationPromise = pendingValidation;
    return pendingValidation;
  };
  const runLogin = async (): Promise<ZhiliuAccountStatus> => {
    const requestedEpoch = generation;
    const cancelled = () => loggedOut("本次登录已取消，请按需重新登录");
    if (logoutPromise) await logoutPromise;
    if (invalidationCleanup) await invalidationCleanup;
    await initialize();
    if (generation !== requestedEpoch) return cancelled();
    if (current) {
      await validate(true);
      if (generation !== requestedEpoch) return cancelled();
    }
    if (current) return status();
    const epoch = ++generation;
    validationPromise = undefined;
    pollAbort.abort();
    const controller = new AbortController();
    pollAbort = controller;
    projection = { phase: "authorizing", message: "正在系统浏览器中授权织流" };
    let received: StoredZhiliuAccount | null = null;
    try {
      const origin = resolveZhiliuCloudTarget(options.cloudUrl()).origin;
      const pending = await beginZhiliuAccountAuthorization(origin, http, now);
      if (generation !== epoch) return cancelled();
      browserUrl = pending.verificationUrl;
      projection = {
        phase: "authorizing",
        userCode: pending.userCode,
        expiresAt: pending.expiresAt,
        message: "请在浏览器核对连接码、账号和空间后批准",
      };
      await options.openExternal(pending.verificationUrl);
      if (generation !== epoch) return cancelled();
      void showMessageBox({
        type: "info",
        title: "登录织流",
        message: `本机连接码：${pending.userCode}`,
        detail:
          "请在系统浏览器核对相同连接码、账号和空间后批准。此操作只登录账号，不开放本机目录。",
        buttons: ["知道了"],
        noLink: true,
      }).catch(() => undefined);
      while (generation === epoch && now() < Date.parse(pending.expiresAt)) {
        received = await pending.exchange();
        if (received) break;
        await wait(pending.pollIntervalMs, controller.signal);
      }
      if (generation !== epoch) {
        if (received) await revokeQuietly(received);
        return cancelled();
      }
      if (!received) {
        projection = loggedOut("登录授权已超时，请重新登录");
        return status();
      }
      const accepted = received;
      await withCredentials(async () => {
        if (generation === epoch) await store.write(accepted);
      });
      if (generation !== epoch) {
        await discardReceived(accepted);
        return cancelled();
      }
      current = accepted;
      return authenticated(accepted.credential);
    } catch {
      if (received) await discardReceived(received).catch(() => revokeQuietly(received!));
      if (generation === epoch)
        projection = loggedOut("登录未完成，请检查网络、浏览器和系统安全存储后重试");
      return generation === epoch ? status() : cancelled();
    } finally {
      if (generation === epoch) browserUrl = undefined;
    }
  };
  const login = (): Promise<ZhiliuAccountStatus> => {
    if (loginPromise) {
      if (browserUrl) void options.openExternal(browserUrl).catch(() => undefined);
      return loginPromise;
    }
    const operation = runLogin();
    loginPromise = operation;
    const finish = () => {
      if (loginPromise === operation) loginPromise = undefined;
    };
    void operation.then(finish, finish);
    return operation;
  };
  const cancelLogin = () => {
    if (!loginPromise && projection.phase !== "authorizing") return;
    generation++;
    validationPromise = undefined;
    pollAbort.abort();
    browserUrl = undefined;
    if (!current) projection = loggedOut("登录已取消");
    loginPromise = undefined;
  };
  const authorizeCloud = async (open = options.openCloudSession): Promise<boolean> => {
    if (!open) throw new Error("云工作台入口未配置");
    if ((await validate(true)).phase !== "authenticated" || !current) return false;
    const record = current,
      epoch = generation;
    return withCloud(async () => {
      if (generation !== epoch || current !== record) return false;
      try {
        const ticket = await createZhiliuAccountBootstrap(record, http, now);
        if (generation !== epoch || current !== record) return false;
        await open(ticket, record.origin);
        return generation === epoch && current === record;
      } catch {
        throw new Error("无法授权云工作台，请重试");
      }
    });
  };
  const logout = () => {
    if (logoutPromise) return logoutPromise;
    const operation = (async () => {
      const answer = await showMessageBox({
        type: "warning",
        title: "退出织流",
        message: "确认退出登录？",
        detail:
          "退出后，网页将无法控制这台电脑执行任务。当前电脑连接会断开，本机待确认操作会取消。云端任务可能继续运行。",
        buttons: ["取消", "退出登录"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { confirmed: false, remoteRevoked: false };
      generation++;
      validationPromise = undefined;
      pollAbort.abort();
      browserUrl = undefined;
      loginPromise = undefined;
      let localFailure = false;
      try {
        await options.pauseComputer();
      } catch {
        localFailure = true;
      }
      // 本机删除排在已开始的保存之后；旧代次不能在退出后重新写回凭据。
      const origin = resolveZhiliuCloudTarget(options.cloudUrl()).origin;
      let record = current;
      current = null;
      initialized = true;
      projection = loggedOut("已在本机退出织流");
      try {
        await options.disconnectComputer();
      } catch {
        localFailure = true;
      }
      try {
        await withCredentials(async () => {
          record ??= await store.read(origin).catch(() => null);
          await store.remove(origin);
        });
      } catch {
        localFailure = true;
      }
      let remoteRevoked = !record;
      try {
        if (record) {
          await revokeZhiliuAccount(record, http);
          remoteRevoked = true;
        }
      } catch {
        projection = loggedOut("本机已退出，远端撤销未确认；可在网页撤销设备");
      } finally {
        try {
          await withCloud(() => options.clearCloudSession(origin));
        } catch {
          localFailure = true;
        }
      }
      if (localFailure) {
        projection = loggedOut("本机退出清理未完成，请关闭客户端并在网页撤销设备");
        throw new Error("本机退出清理未完成，请关闭客户端并在网页撤销设备");
      }
      if (!remoteRevoked)
        await showMessageBox({
          type: "warning",
          title: "已在本机退出",
          message: "远端撤销尚未确认",
          detail: "本机凭据和电脑连接已清除。请联网后在织流网页撤销对应设备。",
          buttons: ["知道了"],
          noLink: true,
        });
      return { confirmed: true, remoteRevoked };
    })();
    logoutPromise = operation;
    const finish = () => {
      if (logoutPromise === operation) logoutPromise = undefined;
    };
    void operation.then(finish, finish);
    return operation;
  };
  const getDeviceIdentity = async () => {
    if ((await validate(true)).phase !== "authenticated" || !current) return null;
    return {
      privateKey: current.privateKey,
      publicKey: current.publicKey,
      deviceId: current.credential.device_id,
      userId: current.credential.user_id,
      spaceId: current.credential.space_id,
    };
  };
  return { login, logout, status, getStatus: () => validate(false), authorizeCloud, cancelLogin, getDeviceIdentity };
}
