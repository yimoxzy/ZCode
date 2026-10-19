import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright-core";

// 仅启动开发构建；不修改发布 fuse，不增加生产绕过，不请求模型或充值接口。
const origin = "http://127.0.0.1:18780";
const desktopRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const tempRoot = await realpath(tmpdir());
const scratch = await mkdtemp(join(tempRoot, "zhiliu-host-process-"));
const workspace = join(scratch, "workspace");
const profile = join(scratch, "profile");
const relativePath = `smoke-${randomUUID()}.md`;
const content = "织流真实 Host 进程验收：只允许本次临时文件写入。\n";
const sha256 = createHash("sha256").update(content).digest("hex");
let app;
let cloud;
let token;
let deviceId;
let stage = "setup";
let failedStage;
let cleanupFailed = false;
let checks = 0;
let operationReviews = 0;
let resultReviews = 0;
let diagnostics = null;

function ensure(value) {
  if (!value) throw new Error("Host process smoke condition failed");
}

async function request(path, method = "GET", body) {
  ensure(
    /^\/api\/(?:ready|auth\/(?:register|logout)|billing\/balance|devices(?:\/[a-f0-9-]{36}(?:\/tools(?:\/[a-f0-9-]{36})?)?)?|desktop-host\/authorizations\/[a-f0-9-]{36}(?:\/approve)?)$/u.test(
      path,
    ),
  );
  const response = await fetch(`${origin}${path}`, {
    method,
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12_000),
  });
  ensure(response.ok);
  return response.json();
}

async function until(predicate, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(150);
  }
  throw new Error("Host process smoke timed out");
}

async function reviewWindow(title) {
  let found;
  await until(async () => {
    const matches = [];
    for (const window of app.windows()) {
      if (!window.isClosed() && (await window.title()) === title) matches.push(window);
    }
    ensure(matches.length <= 1);
    found = matches[0];
    return Boolean(found);
  });
  await found.locator("pre").waitFor({ state: "visible" });
  const bridge = await found.evaluate(() => ({
    zcode: typeof window.zcode,
    desktop: typeof window.desktop,
    node: typeof window.require,
  }));
  ensure(Object.values(bridge).every((value) => value === "undefined"));
  const preferences = await app.evaluate(({ BrowserWindow }, expectedTitle) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.getTitle() === expectedTitle);
    const value = window?.webContents.getLastWebPreferences();
    return value
      ? {
          sandbox: value.sandbox,
          contextIsolation: value.contextIsolation,
          nodeIntegration: value.nodeIntegration,
          preload: Boolean(value.preload),
        }
      : null;
  }, title);
  ensure(
    preferences?.sandbox === true &&
      preferences.contextIsolation === true &&
      preferences.nodeIntegration === false &&
      !preferences.preload,
  );
  return found;
}

async function clickExactReview(window, choice, label) {
  const link = window.getByRole("link", { name: label, exact: true });
  ensure((await link.count()) === 1);
  ensure(
    new RegExp(`^https://zhiliu\\.invalid/review/[a-f0-9-]{36}/${choice}$`, "u").test(
      (await link.getAttribute("href")) ?? "",
    ),
  );
  // 通过真实导航事件回答审批；不直接调用 Main/Host 的审批回调。
  await link.click({ noWaitAfter: true });
}

try {
  ensure(process.argv.length === 2);
  await mkdir(workspace, { mode: 0o700 });
  stage = "readiness";
  const ready = await request("/api/ready");
  ensure(ready.status === "ready" && ready.worker === "ready");
  checks++;

  stage = "register";
  const login = await request("/api/auth/register", "POST", {
    email: `zhiliu-host-process+${randomUUID()}@example.com`,
    password: randomBytes(32).toString("base64url"),
    nickname: "织流进程链路验收",
  });
  token = login.access_token;
  ensure(typeof token === "string" && login.user.is_admin === false);
  const balance = await request("/api/billing/balance");
  checks++;

  stage = "launch";
  const env = {
    ...process.env,
    ZCODE_DATA_BASE_DIR: join(scratch, "data"),
    ZCODE_DESKTOP_HOME_DIR: scratch,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ZHILIU_CLOUD_URL: `${origin}/`,
  };
  for (const name of ["ELECTRON_RUN_AS_NODE", "DEBUG", "PWDEBUG"]) delete env[name];
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [desktopRoot],
    cwd: desktopRoot,
    env,
    timeout: 60_000,
  });
  const security = await app.evaluate(({ app, safeStorage }) => ({
    packaged: app.isPackaged,
    encrypted: safeStorage.isEncryptionAvailable(),
    basicText: safeStorage.getSelectedStorageBackend?.() === "basic_text",
  }));
  ensure(!security.packaged && security.encrypted && !security.basicText);
  const local = await app.firstWindow({ timeout: 60_000 });
  await local.getByTestId("root-startup-loading").waitFor({ state: "hidden", timeout: 60_000 });
  await local.getByTestId("zhiliu-connect-computer").waitFor({ state: "visible" });
  const hostPids = await app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((value) => value.type === "Utility" && value.name?.startsWith("zcode-host"))
      .map((value) => value.pid),
  );
  ensure(hostPids.length === 1);
  checks++;

  stage = "connect-ui";
  await app.evaluate(({ dialog }, selectedPath) => {
    const state = { messages: 0, pickers: 0, unexpected: false, userCode: "" };
    globalThis.__zhiliuHostProcessSmoke = state;
    const originalMessage = dialog.showMessageBox;
    const originalPicker = dialog.showOpenDialog;
    state.restore = () => {
      dialog.showMessageBox = originalMessage;
      dialog.showOpenDialog = originalPicker;
    };
    dialog.showMessageBox = async (...args) => {
      const value = args.at(-1);
      state.messages++;
      if (value.title !== "连接织流账号" || !/^本机连接码：[A-F0-9]{8}$/u.test(value.message)) {
        state.unexpected = true;
        return { response: 0, checkboxChecked: false };
      }
      state.userCode = value.message.slice("本机连接码：".length);
      return { response: 0, checkboxChecked: false };
    };
    dialog.showOpenDialog = async (...args) => {
      const value = args.at(-1);
      state.pickers++;
      if (
        value.title !== "选择允许织流云 Agent 访问的工作目录" ||
        value.properties?.join(",") !== "openDirectory"
      ) {
        state.unexpected = true;
        return { canceled: true, filePaths: [] };
      }
      return { canceled: false, filePaths: [selectedPath] };
    };
  }, workspace);
  stage = "cloud-window";
  [cloud] = await Promise.all([
    app.waitForEvent("window", { timeout: 30_000 }),
    local.getByTestId("zhiliu-connect-computer").click(),
  ]);
  stage = "cloud-origin";
  await until(() => cloud.url().startsWith(`${origin}/`));
  stage = "authorization-preview";
  const authorizationId = /[?&]connect=([a-f0-9-]{36})/u.exec(cloud.url())?.[1];
  ensure(authorizationId);
  const preview = await request(`/api/desktop-host/authorizations/${authorizationId}`);
  ensure(preview.status === "pending");
  stage = "connection-code";
  await until(() => app.evaluate(() => Boolean(globalThis.__zhiliuHostProcessSmoke.userCode)));
  ensure(
    await app.evaluate((_electron, code) => {
      const value = globalThis.__zhiliuHostProcessSmoke;
      return value.messages === 1 && !value.unexpected && value.userCode === code;
    }, preview.user_code),
  );
  stage = "authorization-approve";
  const approved = await request(
    `/api/desktop-host/authorizations/${authorizationId}/approve`,
    "POST",
    {
      user_code: preview.user_code,
    },
  );
  deviceId = approved.device_id;
  ensure(approved.user_id === login.user.id && approved.space_id === login.space.id);
  checks++;

  stage = "host-online";
  await until(async () => {
    const value = await cloud.evaluate(
      async ({ accessToken, id }) => {
        const response = await fetch("/api/devices", {
          redirect: "error",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) return null;
        const rows = await response.json();
        return rows.find((row) => row.id === id) ?? null;
      },
      { accessToken: token, id: deviceId },
    );
    return (
      value?.connection_kind === "paired_host" &&
      value.online === true &&
      value.workspace_ready === true &&
      value.capabilities.includes("file_write")
    );
  });
  const bridge = await cloud.evaluate(() => ({
    zcode: typeof window.zcode,
    desktop: typeof window.desktop,
    node: typeof window.require,
  }));
  ensure(Object.values(bridge).every((value) => value === "undefined"));
  const connectedHostPids = await app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((value) => value.type === "Utility" && value.name?.startsWith("zcode-host"))
      .map((value) => value.pid),
  );
  ensure(connectedHostPids.length === 1 && connectedHostPids[0] === hostPids[0]);
  const credentials = await readdir(join(profile, "host-credentials"));
  ensure(credentials.length === 1 && /^[a-f0-9]{64}\.sealed$/u.test(credentials[0]));
  ensure((await readFile(join(profile, "host-credentials", credentials[0]))).length > 0);
  checks += 2;

  stage = "file-request";
  const row = await request(`/api/devices/${deviceId}/tools`, "POST", {
    tool: "file_write",
    arguments: { path: relativePath, content },
  });
  ensure(row.device_id === deviceId && row.status === "pending" && row.tool === "file_write");
  ensure(row.arguments.path === relativePath && row.arguments.content === content);
  stage = "operation-review";
  const operation = await reviewWindow("织流请求访问本机文件");
  const expected = `当前授权目录：${basename(workspace)}\n操作：写入文件\n相对路径：${relativePath}\n请求：${row.id}\n\n完整写入内容：\n${content}\n\n仅允许这一次。不会执行终端或鼠标键盘操作。`;
  ensure((await operation.locator("pre").textContent()) === expected);
  ensure((await readdir(workspace)).length === 0);
  await clickExactReview(operation, "approve", "允许这一次");
  operationReviews++;
  checks++;

  stage = "result-review";
  const result = await reviewWindow("发送本机执行结果到织流");
  const detail = await result.locator("pre").textContent();
  const prefix = `状态：completed\n相对路径：${relativePath}\n\n以下是将发送到当前账号空间的完整内容（按常见凭据格式脱敏，请核对）：\n\n`;
  const suffix = "\n\n选择只发摘要会隐藏文件内容；取消不会回滚已经发生的本机文件修改。";
  ensure(detail.startsWith(prefix) && detail.endsWith(suffix));
  const metadata = JSON.parse(detail.slice(prefix.length, -suffix.length));
  ensure(
    metadata.relativePath === relativePath &&
      metadata.sha256 === sha256 &&
      metadata.sizeBytes === Buffer.byteLength(content) &&
      /^[a-f0-9]{64}$/u.test(metadata.fingerprint) &&
      Object.keys(metadata).length === 4,
  );
  ensure((await readFile(join(workspace, relativePath), "utf8")) === content);
  await clickExactReview(result, "content", "发送以上完整内容");
  resultReviews++;
  checks++;

  stage = "completion";
  let completed;
  await until(async () => {
    completed = await request(`/api/devices/${deviceId}/tools/${row.id}`);
    ensure(!["failed", "rejected", "cancelled", "expired"].includes(completed.status));
    return completed.status === "completed";
  });
  ensure(JSON.parse(completed.output).sha256 === sha256);
  ensure(
    await app.evaluate(() => {
      const value = globalThis.__zhiliuHostProcessSmoke;
      return value.messages === 1 && value.pickers === 1 && !value.unexpected;
    }),
  );
  const after = await request("/api/billing/balance");
  ensure(after.balance === balance.balance && after.reserved === balance.reserved);
  checks += 2;
} catch {
  // Playwright/HTTP 原始异常可能带 URL、认证参数或响应；只输出预定义阶段名。
  failedStage = stage;
  diagnostics = app
    ? await app
        .evaluate(({ BrowserWindow }) => {
          const value = globalThis.__zhiliuHostProcessSmoke;
          return {
            messages: value?.messages ?? 0,
            pickers: value?.pickers ?? 0,
            unexpected: value?.unexpected === true,
            cloudWindows: BrowserWindow.getAllWindows().filter((window) =>
              window.webContents.getURL().startsWith("http://127.0.0.1:18780/"),
            ).length,
          };
        })
        .catch(() => null)
    : null;
} finally {
  if (token && deviceId) {
    try {
      ensure((await request(`/api/devices/${deviceId}`, "DELETE")).ok === true);
    } catch {
      cleanupFailed = true;
    }
  }
  if (token) {
    try {
      await request("/api/auth/logout", "POST");
    } catch {
      cleanupFailed = true;
    }
  }
  if (app) {
    await app.evaluate(() => globalThis.__zhiliuHostProcessSmoke?.restore()).catch(() => {});
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  try {
    // 仅清理本脚本创建且已核对边界的目录，不枚举/终止其他客户端进程。
    ensure(
      dirname(resolve(scratch)) === tempRoot &&
        basename(scratch).startsWith("zhiliu-host-process-"),
    );
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  } catch {
    cleanupFailed = true;
  }
}

const passed = !failedStage && !cleanupFailed;
process.exitCode = passed ? 0 : 1;
(passed ? process.stdout : process.stderr).write(
  `${JSON.stringify({
    passed,
    checks,
    operationReviews,
    resultReviews,
    failedStage: failedStage ?? null,
    cleanupFailed,
    diagnostics,
    nativePickerManuallyTested: false,
    note: "Development Electron and real utility Host; native review required. No model requests. Picker mocked in test only.",
  })}\n`,
);
