import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beginZhiliuHostAuthorization } from "../src/main/zhiliuHostAuthorization.js";
import { ZhiliuToolConnection } from "../src/host/zhiliuToolConnection.js";
import { zhiliuToolRequestSchema } from "@zcode/shared";

const origin = "http://127.0.0.1:18780";
const content = "织流电脑连接 smoke：仅测试临时目录。\n";
const revokedContent = "此写入必须在撤销后被阻止。\n";
const filePath = "smoke-document.md";
const revokedPath = "must-not-exist.md";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Row = {
  id: string;
  device_id: string;
  user_id: string;
  space_id: string;
  tool: "file_read" | "file_write";
  arguments: { path: string; content?: string };
  status: string;
  output: string | null;
};
type Expected = { row: Row; holdForRevoke: boolean };

function ensure(value: unknown): asserts value {
  if (!value) throw new Error("Smoke condition failed");
}

/** 普通 REST 账号模拟网页，Host 使用真实桌面模块；绝不请求聊天/模型接口。 */
export async function runLiveComputerSmoke(scratch: string) {
  let stage = "setup";
  let checks = 0;
  let token: string | undefined;
  let deviceId: string | undefined;
  let revoked = false;
  let connection: ZhiliuToolConnection | undefined;
  let cleanupFailed = false;
  let failureStage: string | undefined;
  let reviewFailed = false;
  let operationReviews = 0;
  let resultReviews = 0;
  let lastAccountStatus = 0;
  let lastHostStatus = 0;
  let invalidHostRows = 0;
  let schemaIssue = "none";
  let blockedReviewSeen = false;
  let revokedHostResponse = false;
  let active: Expected | undefined;
  let recordingRequest: Promise<void> | undefined;
  let releaseBlocked!: (answer: string) => void;
  const blockedAnswer = new Promise<string>((resolve) => (releaseBlocked = resolve));
  const expected = new Map<string, Expected>();
  const pendingPolls = new Set<Promise<unknown>>();
  const workspace = join(scratch, "workspace");

  const request = async (path: string, method = "GET", body?: unknown, auth = token) => {
    const allowed =
      /^\/api\/(?:ready|auth\/(?:register|me|logout)|billing\/balance|devices(?:\/[a-f0-9-]{36}(?:\/tools(?:\/[a-f0-9-]{36})?)?)?|desktop-host\/authorizations\/[a-f0-9-]{36}(?:\/approve)?)$/u;
    ensure(allowed.test(path));
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
    });
    lastAccountStatus = response.status;
    return response;
  };
  const json = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, method, body);
    ensure(response.ok);
    return response.json();
  };
  const hostFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    ensure(url.origin === origin);
    ensure(
      /^\/api\/desktop-host\/(?:authorizations|exchange|devices\/[a-f0-9-]{36}\/(?:heartbeat|tools(?:\/[a-f0-9-]{36}(?:\/(?:decision|result))?)?))$/u.test(
        url.pathname,
      ),
    );
    ensure(init?.redirect === "error");
    const response = await fetch(input, init);
    lastHostStatus = response.status;
    if (response.ok && /\/tools(?:\/[a-f0-9-]{36})?$/u.test(url.pathname)) {
      const value = await response.clone().json();
      for (const row of Array.isArray(value) ? value : [value]) {
        const parsed = zhiliuToolRequestSchema.safeParse(row);
        if (!parsed.success) {
          invalidHostRows++;
          const field = parsed.error.issues[0]?.path[0];
          schemaIssue = [
            "id",
            "device_id",
            "user_id",
            "space_id",
            "nonce",
            "tool",
            "arguments",
            "status",
            "expires_at",
          ].includes(String(field))
            ? String(field)
            : "other";
        }
      }
    }
    if (revoked && [401, 403, 404, 410].includes(response.status)) revokedHostResponse = true;
    return response;
  };
  const waitUntil = async (predicate: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      ensure(!reviewFailed);
      if (await predicate()) return;
      await delay(100);
    }
    throw new Error("Smoke timed out");
  };
  const startPoll = () => {
    const poll = connection!.poll().catch(() => {
      if (!revoked) reviewFailed = true;
    });
    pendingPolls.add(poll);
    void poll.finally(() => pendingPolls.delete(poll));
  };
  const completed = async (row: Row) => {
    let result: Row | undefined;
    await waitUntil(async () => {
      await connection!.poll();
      result = await json(`/api/devices/${deviceId}/tools/${row.id}`);
      ensure(!["failed", "rejected", "cancelled", "expired"].includes(result!.status));
      return result!.status === "completed";
    });
    return result!;
  };
  const addTool = async (
    tool: Row["tool"],
    arguments_: Row["arguments"],
    holdForRevoke = false,
  ) => {
    let recorded!: () => void;
    recordingRequest = new Promise<void>((resolve) => (recorded = resolve));
    try {
      const row: Row = await json(`/api/devices/${deviceId}/tools`, "POST", {
        tool,
        arguments: arguments_,
      });
      ensure(row.device_id === deviceId && row.status === "pending");
      ensure(row.tool === tool && row.arguments.path === arguments_.path);
      ensure(row.arguments.content === arguments_.content);
      expected.set(row.id, { row, holdForRevoke });
      return row;
    } finally {
      recorded();
      recordingRequest = undefined;
    }
  };

  try {
    await mkdir(workspace, { mode: 0o700 });
    stage = "readiness";
    ensure((await json("/api/ready")).status === "ready");
    checks++;

    stage = "register";
    const login = await json("/api/auth/register", "POST", {
      email: `zhiliu-computer-smoke+${randomUUID()}@example.com`,
      password: randomBytes(32).toString("base64url"),
      nickname: "织流电脑连接测试",
    });
    token = login.access_token;
    ensure(typeof token === "string" && !login.user.is_admin);
    const balance = await json("/api/billing/balance");
    checks++;

    stage = "authorization";
    const pending = await beginZhiliuHostAuthorization(origin, hostFetch);
    ensure((await pending.exchange()) === null);
    const preview = await json(`/api/desktop-host/authorizations/${pending.authorizationId}`);
    ensure(preview.user_code === pending.userCode && preview.status === "pending");
    const approved = await json(
      `/api/desktop-host/authorizations/${pending.authorizationId}/approve`,
      "POST",
      { user_code: pending.userCode },
    );
    deviceId = approved.device_id;
    const record = await pending.exchange();
    ensure(record);
    ensure(
      record.credential.device_id === deviceId &&
        record.credential.user_id === login.user.id &&
        record.credential.space_id === login.space.id,
    );
    let replayRejected = false;
    try {
      await pending.exchange();
    } catch {
      replayRejected = true;
    }
    ensure(replayRejected);
    checks += 3;

    stage = "connection";
    connection = new ZhiliuToolConnection({
      origin,
      credential: record.credential,
      privateKey: record.privateKey,
      stateDirectory: join(scratch, "journal"),
      workspacePath: workspace,
      fetch: hostFetch,
      status: () => {},
      review: async (kind, title, detail) => {
        try {
          if (kind === "operation") {
            // 服务已提交请求后，Host 轮询可能先于网页 POST 回执；先等登记再严格核对 ID。
            await recordingRequest;
            ensure(active === undefined);
            const id = /^请求：([a-f0-9-]{36})$/mu.exec(detail)?.[1];
            const item = id ? expected.get(id) : undefined;
            ensure(item);
            const row = item.row;
            ensure(title === "织流请求访问本机文件");
            ensure(
              detail ===
                `当前授权目录：${basename(workspace)}\n操作：${row.tool === "file_read" ? "读取文件" : "写入文件"}\n相对路径：${row.arguments.path}\n请求：${row.id}\n\n${row.tool === "file_write" ? `完整写入内容：\n${row.arguments.content}` : "文件内容将在本机读取，发送到云端前会再次征求确认。"}\n\n仅允许这一次。不会执行终端或鼠标键盘操作。`,
            );
            ensure(
              row.arguments.path === (item.holdForRevoke ? revokedPath : filePath) &&
                (row.tool === "file_read" ||
                  row.arguments.content === (item.holdForRevoke ? revokedContent : content)),
            );
            active = item;
            operationReviews++;
            if (item.holdForRevoke) {
              blockedReviewSeen = true;
              return await blockedAnswer;
            }
            return "approve";
          }
          ensure(active && !active.holdForRevoke);
          ensure(title === "发送本机执行结果到织流");
          const row = active.row;
          const prefix = `状态：completed\n相对路径：${row.arguments.path}\n\n以下是将发送到当前账号空间的完整内容（按常见凭据格式脱敏，请核对）：\n\n`;
          const suffix = "\n\n选择只发摘要会隐藏文件内容；取消不会回滚已经发生的本机文件修改。";
          ensure(detail.startsWith(prefix) && detail.endsWith(suffix));
          const output = detail.slice(prefix.length, -suffix.length);
          if (row.tool === "file_read") ensure(output === content);
          else {
            const metadata = JSON.parse(output);
            ensure(
              metadata.relativePath === filePath &&
                metadata.sha256 === hash(content) &&
                metadata.sizeBytes === Buffer.byteLength(content) &&
                /^[a-f0-9]{64}$/u.test(metadata.fingerprint) &&
                Object.keys(metadata).length === 4,
            );
          }
          resultReviews++;
          active = undefined;
          return "content";
        } catch {
          reviewFailed = true;
          return kind === "operation" ? "reject" : "summary";
        }
      },
    });
    await connection.start();
    const devices = await json("/api/devices");
    const device = devices.find((row: { id: string }) => row.id === deviceId);
    ensure(
      device?.connection_kind === "paired_host" &&
        device.online === true &&
        device.workspace_ready === true &&
        device.capabilities.includes("file_read") &&
        device.capabilities.includes("file_write"),
    );
    checks++;

    stage = "file-write";
    const write = await addTool("file_write", { path: filePath, content });
    await completed(write);
    ensure((await readFile(join(workspace, filePath), "utf8")) === content);
    checks++;

    stage = "file-read";
    const read = await addTool("file_read", { path: filePath });
    ensure((await completed(read)).output === content);
    ensure(operationReviews === 2 && resultReviews === 2 && !reviewFailed);
    checks++;

    stage = "idempotency";
    await connection.poll();
    ensure(operationReviews === 2 && resultReviews === 2);
    checks++;

    stage = "revocation";
    await addTool("file_write", { path: revokedPath, content: revokedContent }, true);
    startPoll();
    await waitUntil(() => blockedReviewSeen);
    ensure((await json(`/api/devices/${deviceId}`, "DELETE")).ok === true);
    revoked = true;
    releaseBlocked("approve");
    await waitUntil(() => revokedHostResponse);
    await Promise.allSettled(pendingPolls);
    let absent = false;
    try {
      await stat(join(workspace, revokedPath));
    } catch (error) {
      absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    ensure(absent && resultReviews === 2);
    const denied = await request(`/api/devices/${deviceId}/tools`, "POST", {
      tool: "file_write",
      arguments: { path: revokedPath, content: revokedContent },
    });
    ensure([401, 403, 404, 410].includes(denied.status));
    const after = (await json("/api/devices")).find((row: { id: string }) => row.id === deviceId);
    ensure(
      after?.status === "revoked" && after.online === false && after.workspace_ready === false,
    );
    checks += 3;

    stage = "billing";
    const afterBalance = await json("/api/billing/balance");
    ensure(afterBalance.balance === balance.balance && afterBalance.reserved === balance.reserved);
    checks++;
  } catch {
    failureStage = stage;
  } finally {
    releaseBlocked("reject");
    if (connection) await connection.stop().catch(() => (cleanupFailed = true));
    await Promise.allSettled(pendingPolls);
    if (token && deviceId && !revoked) {
      try {
        const response = await request(`/api/devices/${deviceId}`, "DELETE");
        if (!response.ok) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
    if (token) {
      try {
        const response = await request("/api/auth/logout", "POST");
        if (!response.ok) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed || failureStage)
    throw Object.assign(new Error(`Live computer smoke failed at ${failureStage ?? "cleanup"}`), {
      diagnostics: {
        checks,
        operationReviews,
        resultReviews,
        reviewFailed,
        lastAccountStatus,
        lastHostStatus,
        invalidHostRows,
        schemaIssue,
      },
    });
  return {
    passed: true,
    checks,
    operationReviews,
    resultReviews,
    note: "Real device APIs and desktop file modules passed; no model requests. Native UI not tested.",
  };
}
