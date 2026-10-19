import {
  app,
  dialog,
  MessageChannelMain,
  safeStorage,
  type MessagePortMain,
  type UtilityProcess,
} from "electron";
import { join } from "node:path";
import { HostMessageTypes, zhiliuToolPortEventSchema } from "@zcode/shared";
import { resolveZhiliuCloudTarget } from "./zhiliuCloudPolicy.js";
import { openZhiliuCloudWindow } from "./zhiliuCloudWindow.js";
import {
  beginZhiliuHostAuthorization,
  ZhiliuHostStore,
  type StoredZhiliuHost,
} from "./zhiliuHostAuthorization.js";
import { showZhiliuNativeReview } from "./zhiliuNativeReview.js";

export interface ZhiliuComputerConnectionOptions {
  cloudUrl: () => string | undefined;
  resolveHost: () => UtilityProcess | null;
  iconPath?: string;
}
/** Main 不保存工具队列或执行状态；只调度现有 Host、系统凭据和原生审批。 */
export function createZhiliuComputerConnection(options: ZhiliuComputerConnectionOptions) {
  let port: MessagePortMain | undefined;
  let owner: UtilityProcess | undefined;
  let review: ReturnType<typeof showZhiliuNativeReview> | undefined;
  let generation = 0,
    connecting = false;
  let message = "尚未连接电脑";
  const store = () =>
    new ZhiliuHostStore(join(app.getPath("userData"), "host-credentials"), safeStorage);
  let credentialOperation = Promise.resolve();
  // 断开必须排在已经开始的保存之后；仅检查 generation 不能阻止迟到的磁盘写入复活凭据。
  const withCredentials = <T>(operation: (value: ZhiliuHostStore) => Promise<T>): Promise<T> => {
    const result = credentialOperation.then(() => operation(store()));
    credentialOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const pause = () => {
    generation++;
    review?.close();
    review = undefined;
    port?.postMessage({ type: "stop" });
    port?.close();
    port = undefined;
    owner = undefined;
    message = "电脑连接已暂停，网页不能执行本机文件操作";
  };
  const connect = async () => {
    if (connecting) return;
    connecting = true;
    pause();
    const epoch = generation;
    try {
      const target = resolveZhiliuCloudTarget(options.cloudUrl());
      let record: StoredZhiliuHost | null = await withCredentials((value) =>
        value.read(target.origin),
      );
      if (generation !== epoch) return;
      if (!record) {
        const pending = await beginZhiliuHostAuthorization(target.origin);
        if (generation !== epoch) return;
        await openZhiliuCloudWindow({
          cloudUrl: options.cloudUrl(),
          iconPath: options.iconPath,
          entry: "devices",
          authorizationId: pending.authorizationId,
        });
        void dialog.showMessageBox({
          type: "info",
          title: "连接织流账号",
          message: `本机连接码：${pending.userCode}`,
          detail:
            "在织流网页核对相同连接码，并确认要连接的账号和空间。账号授权后还需在电脑选择允许访问的目录。",
          buttons: ["知道了"],
        });
        while (Date.now() < Date.parse(pending.expiresAt)) {
          if (generation !== epoch) return;
          record = await pending.exchange();
          if (record) break;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        if (!record || generation !== epoch) return;
        const authorizedRecord = record;
        await withCredentials(async (value) => {
          if (generation === epoch) await value.write(authorizedRecord);
        });
      }
      if (generation !== epoch) return;
      const directory = await dialog.showOpenDialog({
        title: "选择允许织流云 Agent 访问的工作目录",
        properties: ["openDirectory"],
        buttonLabel: "授权此目录",
      });
      if (directory.canceled || !directory.filePaths[0] || generation !== epoch) return;
      const host = options.resolveHost();
      if (!host) throw new Error("请保持一个本地工作台窗口打开后重新连接");
      const { port1, port2 } = new MessageChannelMain();
      port = port1;
      owner = host;
      port1.on("message", (event) => {
        if (generation !== epoch) return;
        const result = zhiliuToolPortEventSchema.safeParse(event.data);
        if (!result.success) {
          pause();
          return;
        }
        const data = result.data;
        if (data.type === "status") {
          message = data.message;
          return;
        }
        review?.close();
        const currentReview = showZhiliuNativeReview(data.kind, data.title, data.detail);
        review = currentReview;
        void currentReview.answer.then((answer) => {
          if (generation === epoch && port === port1)
            port1.postMessage({ type: "answer", id: data.id, answer });
          if (review === currentReview) review = undefined;
        });
      });
      port1.on("close", () => {
        if (port === port1) {
          port = undefined;
          review?.close();
          review = undefined;
          message = "电脑连接已停止，请重新连接";
        }
      });
      host.once("exit", () => {
        if (owner === host) pause();
      });
      port1.start();
      host.postMessage({ type: HostMessageTypes.AttachZhiliuToolsPort }, [port2]);
      port1.postMessage({
        type: "start",
        origin: target.origin,
        credential: record.credential,
        privateKey: record.privateKey,
        workspacePath: directory.filePaths[0],
        stateDirectory: join(app.getPath("userData"), "host-execution-journal"),
      });
      message = "正在连接织流电脑服务";
    } catch {
      if (generation !== epoch) return;
      pause();
      await dialog.showMessageBox({
        type: "error",
        title: "织流电脑连接",
        message: "电脑连接未完成",
        detail: "请检查网络、系统安全存储和账号授权。若网页已撤销设备，请先断开账号再重新连接。",
        buttons: ["知道了"],
      });
    } finally {
      connecting = false;
    }
  };
  const disconnect = async () => {
    pause();
    const epoch = generation;
    const target = resolveZhiliuCloudTarget(options.cloudUrl());
    const record = await withCredentials(async (value) => {
      const current = await value.read(target.origin).catch(() => null);
      await value.remove(target.origin);
      return current;
    });
    if (record) {
      await fetch(
        `${target.origin}/api/desktop-host/devices/${record.credential.device_id}/disconnect`,
        {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${record.credential.host_token}` },
          signal: AbortSignal.timeout(5000),
        },
      ).catch(() => {});
    }
    if (generation === epoch) message = "本机账号授权已移除；可在网页撤销对应设备";
  };
  return {
    connect,
    pause,
    disconnect,
    status: () =>
      dialog.showMessageBox({
        type: "info",
        title: "织流电脑连接",
        message,
        detail:
          "云 Agent 可在本机逐次确认后读写授权目录内的文本文件。任意终端、鼠标键盘控制及完整本地 Agent 尚未开放。此版本的目录守卫不等于操作系统沙箱。",
        buttons: ["知道了"],
      }),
  };
}
