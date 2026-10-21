import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "zhiliu-edition-smoke-"));
const home = join(scratch, "home");
await mkdir(home);

// 仅模拟公开账号合同，不使用真实账号、付费模型或生产认证绕过。
const authorizations = new Map();
const grants = new Map();
const tickets = new Map();
const fixtureErrors = [];
const counts = {
  pending: 0,
  exchange: 0,
  bootstrap: 0,
  consume: 0,
  logout: 0,
  runtime: 0,
  model: 0,
};
const fixtureAgentId = randomUUID(),
  fixtureTierId = randomUUID();
const fixtureUser = {
  id: randomUUID(),
  email: "edition-smoke@example.invalid",
  nickname: "织流验收账号",
  is_admin: false,
};
const fixtureSpace = {
  id: randomUUID(),
  name: "验收空间",
  space_type: "personal",
  role: "owner",
};
const page = `<!doctype html><meta charset="utf-8"><title>Cloud fixture</title>
<h1>正在验证云窗口授权</h1><input aria-label="draft" />
<script type="module">
  window.fixtureBeforeLogin = {
    local: localStorage.getItem("zhiliu-fixture-marker"),
    session: sessionStorage.getItem("zhiliu-fixture-session"),
  };
  const route = new URL(location.hash.slice(1), location.origin);
  const ticket = route.searchParams.get("ticket");
  const destination = route.searchParams.get("next");
  history.replaceState(null, "", "/#/agent");
  try {
    if (route.pathname !== "/desktop-session" || !ticket || destination !== "/agent")
      throw new Error("missing account bootstrap");
    const response = await fetch("/api/desktop-auth/bootstrap/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }),
    });
    if (!response.ok) throw new Error("invalid account bootstrap");
    const value = await response.json();
    sessionStorage.setItem("zhiliu-fixture-session", value.access_token);
    localStorage.setItem("zhiliu-fixture-marker", "signed-in");
    document.querySelector("h1").textContent = "织流云工作台验收";
  } catch {
    document.querySelector("h1").textContent = "云窗口授权失败";
  }
</script>`;

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}
async function readJson(request, maxBytes = 16000) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  assert.ok(body.length <= maxBytes, "fixture request must be bounded");
  return JSON.parse(body.toString("utf8"));
}
function validGrant(request) {
  const grant = grants.get(request.headers.authorization?.replace(/^Bearer /u, ""));
  return grant && !grant.revoked && !grant.invalid ? grant : null;
}
function publicSession(grant) {
  const { login_token: _token, ...session } = grant.credential;
  return session;
}
const fixture = createServer((request, response) => {
  void (async () => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "GET" && route === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    if (request.method === "GET" && route === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && route === "/api/desktop-auth/authorizations") {
      const body = await readJson(request);
      assert.match(body.public_key, /^-----BEGIN PUBLIC KEY-----/u);
      assert.match(body.code_challenge, /^[\w-]{43}$/u);
      assert.equal(body.platform, process.platform);
      const id = randomUUID();
      const pending = {
        authorization_id: id,
        device_code: randomBytes(32).toString("base64url"),
        user_code: "SMOKE-2026",
        expires_at: new Date(Date.now() + 600000).toISOString(),
        poll_interval_seconds: 1,
        verification_path: `/#/desktop-authorize?authorize=${id}`,
      };
      authorizations.set(id, {
        ...pending,
        ...body,
        approved: false,
        consumed: false,
      });
      json(response, 200, pending);
      return;
    }
    if (request.method === "POST" && route === "/api/desktop-auth/exchange") {
      const body = await readJson(request);
      const authorization = authorizations.get(body.authorization_id);
      assert.ok(authorization, "exchange must use a registered authorization");
      assert.equal(body.device_code, authorization.device_code);
      assert.equal(
        createHash("sha256").update(body.code_verifier).digest("base64url"),
        authorization.code_challenge,
        "PKCE proof",
      );
      const proof = `zhiliu-login-exchange\n${body.authorization_id}\n${body.device_code}\n${body.code_verifier}`;
      assert.ok(
        verify(
          null,
          Buffer.from(proof),
          authorization.public_key,
          Buffer.from(body.signature, "base64"),
        ),
        "device key proof",
      );
      if (!authorization.approved) {
        counts.pending++;
        json(response, 409, { detail: "authorization_pending" });
        return;
      }
      if (authorization.consumed) {
        json(response, 409, { detail: "authorization_consumed" });
        return;
      }
      authorization.consumed = true;
      const credential = {
        login_token: `dl_${randomBytes(32).toString("base64url")}`,
        device_id: randomUUID(),
        user_id: fixtureUser.id,
        space_id: fixtureSpace.id,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        user: fixtureUser,
        space: fixtureSpace,
      };
      grants.set(credential.login_token, {
        credential,
        revoked: false,
        invalid: false,
      });
      counts.exchange++;
      json(response, 200, credential);
      return;
    }
    if (request.method === "GET" && route === "/api/desktop-auth/session") {
      const grant = validGrant(request);
      json(response, grant ? 200 : 401, grant ? publicSession(grant) : { detail: "invalid_grant" });
      return;
    }
    if (request.method === "POST" && route === "/api/desktop-auth/relay-grants") {
      const grant = validGrant(request);
      if (!grant) {
        json(response, 401, { detail: "invalid_grant" });
        return;
      }
      const body = await readJson(request);
      assert.equal(body.device_mid, grant.credential.device_id);
      json(response, 200, {
        protocol_version: 1,
        relay_grant: `rc_${randomBytes(32).toString("base64url")}`,
        expires_at: new Date(Date.now() + 300000).toISOString(),
        principal_id: `${fixtureUser.id}:${fixtureSpace.id}`,
        desktop_device_id: grant.credential.device_id,
      });
      return;
    }
    if (request.method === "POST" && route === "/api/desktop-auth/runtime-grants") {
      const grant = validGrant(request);
      if (!grant) {
        json(response, 401, { detail: "invalid_grant" });
        return;
      }
      const body = await readJson(request);
      assert.match(body.workspace_identity, /^local:[a-f0-9]{64}$/u);
      assert.equal(
        body.platform_memory_write_capability,
        "forced_approval_and_execution_identity_v1",
      );
      assert.ok(
        Object.keys(body).every((key) =>
          [
            "workspace_identity",
            "agent_id",
            "inference_profile_id",
            "platform_memory_write_capability",
          ].includes(key),
        ),
      );
      counts.runtime++;
      json(response, 200, {
        protocol_version: 1,
        grant_id: randomUUID(),
        runtime_grant: `rg_${randomBytes(32).toString("base64url")}`,
        expires_at: new Date(Date.now() + 900000).toISOString(),
        gateway_base_url: "/api/runtime-gateway/v1",
        profile: {
          model: "zhiliu-managed",
          display_name: "织流托管模型",
          protocol: "chat_completions",
          max_context_tokens: 32768,
          max_output_tokens: 2048,
          reasoning_effort: null,
          inference_profile_id: null,
          agent: { version_id: null, instructions: "" },
        },
      });
      return;
    }
    if (request.method === "GET" && route === "/api/desktop-auth/runtime-catalog") {
      if (!validGrant(request)) {
        json(response, 401, { detail: "invalid_grant" });
        return;
      }
      json(response, 200, {
        protocol_version: 1,
        agents: [
          {
            id: fixtureAgentId,
            name: "PPT助手",
            description: "平台已发布Agent",
            version_id: fixtureAgentId,
          },
        ],
        inference_profiles: [
          {
            id: fixtureTierId,
            name: "深入思考",
            description: "按平台档位计费",
          },
        ],
      });
      return;
    }
    if (request.method === "POST" && route === "/api/runtime-gateway/mcp") {
      const rpc = await readJson(request);
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "smoke", version: "1" },
            }
          : rpc.method === "tools/list"
            ? { tools: [] }
            : {};
      if (rpc.id === undefined) response.writeHead(202).end();
      else json(response, 200, { jsonrpc: "2.0", id: rpc.id, result });
      return;
    }
    if (request.method === "POST" && route === "/api/runtime-gateway/v1/chat/completions") {
      const body = await readJson(request, 32 * 1024 * 1024);
      assert.equal(body.model, "zhiliu-managed");
      assert.match(request.headers.authorization, /^Bearer rg_/u);
      counts.model++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: "edition model fixture finished" }, null],
        [{}, "stop"],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-edition",
            object: "chat.completion.chunk",
            created: 1,
            model: "zhiliu-managed",
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    if (request.method === "DELETE" && route.startsWith("/api/desktop-auth/runtime-grants/")) {
      json(response, 204);
      return;
    }
    if (request.method === "POST" && route === "/api/desktop-auth/bootstrap") {
      const grant = validGrant(request);
      if (!grant) {
        json(response, 401, { detail: "invalid_grant" });
        return;
      }
      const ticket = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + 60000;
      tickets.set(ticket, { grant, expiresAt, consumed: false });
      counts.bootstrap++;
      json(response, 200, {
        ticket,
        expires_at: new Date(expiresAt).toISOString(),
      });
      return;
    }
    if (request.method === "POST" && route === "/api/desktop-auth/bootstrap/exchange") {
      assert.equal(
        request.headers.authorization,
        undefined,
        "cloud page must not receive native token",
      );
      const pending = tickets.get((await readJson(request)).ticket);
      if (
        !pending ||
        pending.expiresAt <= Date.now() ||
        pending.grant.revoked ||
        pending.grant.invalid
      ) {
        json(response, 410, { detail: "invalid_ticket" });
        return;
      }
      if (pending.consumed) {
        json(response, 409, { detail: "ticket_consumed" });
        return;
      }
      pending.consumed = true;
      counts.consume++;
      json(
        response,
        200,
        {
          access_token: `web_${randomBytes(24).toString("base64url")}`,
          refresh_token: `web_refresh_${randomBytes(24).toString("base64url")}`,
          token_type: "bearer",
          user: fixtureUser,
          space: fixtureSpace,
          desktop_session: true,
        },
        {
          "set-cookie": "zhiliu_fixture_session=signed-in; Path=/; HttpOnly; SameSite=Strict",
        },
      );
      return;
    }
    if (request.method === "POST" && route === "/api/desktop-auth/logout") {
      counts.logout++;
      const grant = validGrant(request);
      if (grant) grant.revoked = true;
      json(response, grant ? 200 : 401, { revoked: Boolean(grant) });
      return;
    }
    throw new Error(`unexpected fixture route: ${request.method} ${route}`);
  })().catch((error) => {
    fixtureErrors.push(error.message);
    if (!response.headersSent) json(response, 500, { detail: "fixture_contract_failed" });
    else response.end();
  });
});
await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USER_DATA_DIR: join(scratch, "profile"),
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZHILIU_CLOUD_URL: origin,
  GLM_BINARY_PATH: resolve(
    desktopRoot,
    `bundled-agents/${process.platform}-${process.arch}/glm/zcode.cjs`,
  ),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ZCODE_DATA_BASE_DIR;
let app;
let stage = "launch";
async function hostWarmupReadyCount() {
  const logDir = join(home, ".zhiliu-desktop", ".zcode", "v2", "logs");
  const files = (await readdir(logDir).catch(() => [])).filter((file) =>
    /^\d{4}-\d{2}-\d{2}\.log$/u.test(file),
  );
  const logs = await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")));
  // 账号可先到达、模型目录稍后 ready；上游 readiness 回调可能接手完成同一次预热。
  // 该日志位于 getOrStartReadOnlyClient/策略同步完成并 markReady 之后，不能只等 grant。
  return logs.join("\n").split("provider/model 就绪，允许 ZCode agent 模型执行").length - 1;
}
async function until(description, condition, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    if (fixtureErrors.length) throw new Error(fixtureErrors.join("; "));
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function credentialFiles() {
  return (
    await readdir(join(scratch, "profile", "account-credentials")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  ).filter((path) => path.endsWith(".sealed"));
}
async function cloudCookies() {
  return app.evaluate(({ BrowserWindow }, cloudOrigin) => {
    const cloudWindow = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith(cloudOrigin),
    );
    // 测试进程保留 partition 引用，窗口销毁之后仍能核验清理结果。
    const state = globalThis.__zhiliuEditionSmoke;
    if (cloudWindow) state.cloudSession = cloudWindow.webContents.session;
    return state.cloudSession.cookies.get({ url: cloudOrigin });
  }, origin);
}
async function signIn(local) {
  const previous = authorizations.size;
  const previousPending = counts.pending;
  const previousRuntime = counts.runtime;
  const previousRuntimeReady = await hostWarmupReadyCount();
  await local
    .getByTestId("zhiliu-account-controls")
    .getByRole("button", { name: "登录织流", exact: true })
    .click();
  await until("registered browser authorization", () => authorizations.size === previous + 1);
  const pending = [...authorizations.values()].at(-1);
  await until("real pending exchange", () => counts.pending > previousPending);
  const browserUrls = await app.evaluate(() => globalThis.__zhiliuEditionSmoke.externalUrls);
  assert.equal(browserUrls.at(-1), `${origin}${pending.verification_path}`);
  assert.equal(app.windows().length, 1, "login must use the system browser");
  await local.getByRole("status").filter({ hasText: "请在浏览器确认登录" }).waitFor();
  pending.approved = true;
  await local
    .getByTestId("zhiliu-account-controls")
    .getByRole("button", { name: "退出登录", exact: true })
    .waitFor({ timeout: 30000 });
  assert.match(
    await local.getByTestId("zhiliu-account-controls").innerText(),
    /织流验收账号.*验收空间/u,
  );
  assert.equal(
    (await credentialFiles()).length,
    1,
    "native account must have one sealed credential file",
  );
  await until(
    "signed-in Host retries its existing workspace model grant",
    () => counts.runtime > previousRuntime,
  );
  await until(
    "signed-in Host completes its real CLI warmup without restarting",
    async () => (await hostWarmupReadyCount()) > previousRuntimeReady,
    60000,
  );
}
async function openCloud(local) {
  const [cloud] = await Promise.all([
    app.waitForEvent("window", { timeout: 30000 }),
    local.getByTestId("zhiliu-open-cloud").click(),
  ]);
  await cloud.getByRole("heading", { name: "织流云工作台验收" }).waitFor({ timeout: 30000 });
  await until("open command completed", () => local.getByTestId("zhiliu-open-cloud").isEnabled());
  return cloud;
}
async function consumeTicket(ticket) {
  return fetch(`${origin}/api/desktop-auth/bootstrap/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
}
const selectionTarget = {
  workspacePath: join(home, "project"),
  workspaceIdentity: "edition-smoke-workspace",
};
async function runtimeCommand(local, command, input = selectionTarget) {
  return local.evaluate(
    ({ command, input }) => window.zcode.executeDesktopCommand(command, input),
    { command, input },
  );
}
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [desktopRoot],
    cwd: desktopRoot,
    env,
    timeout: 60000,
  });
  app.process().stderr?.pipe(process.stderr);
  // 只在本次测试进程截断系统浏览器与原生弹窗；账号和窗口操作仍由真实 UI/Main 执行。
  await app.evaluate(({ shell, dialog }) => {
    const state = {
      externalUrls: [],
      dialogs: [],
      logoutResponses: [],
      cloudSession: null,
    };
    globalThis.__zhiliuEditionSmoke = state;
    shell.openExternal = async (url) => {
      state.externalUrls.push(url);
    };
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      state.dialogs.push({
        title: options.title,
        detail: options.detail,
        buttons: options.buttons,
        defaultId: options.defaultId,
        cancelId: options.cancelId,
      });
      if (options.title === "登录织流") return { response: 0, checkboxChecked: false };
      if (options.title === "退出织流")
        return {
          response: state.logoutResponses.shift() ?? 0,
          checkboxChecked: false,
        };
      throw new Error("Unexpected native dialog in edition smoke");
    };
  });
  const local = await app.firstWindow({ timeout: 60000 });
  await local.getByTestId("zhiliu-workspace-switcher").waitFor({ timeout: 60000 });
  await local.getByTestId("root-startup-loading").waitFor({ state: "hidden", timeout: 60000 });
  assert.equal(await app.evaluate(({ app }) => app.getName()), "织流");
  await local.getByTestId("zhiliu-cloud-access-notice").first().waitFor();
  assert.equal(await local.locator('input[type="password"]').count(), 0);
  assert.equal(await local.getByRole("button", { name: "登录云 Agent", exact: true }).count(), 1);
  await local.screenshot({
    path: process.env.ZHILIU_SMOKE_SCREENSHOT || join(scratch, "local.png"),
  });

  stage = "browser-account-authorization";
  await signIn(local);
  assert.equal(counts.bootstrap, 0, "login must not create a cloud or file-tools session");
  stage = "native-managed-model-task";
  await local.getByTestId("v4-composer-input").fill("Reply with the fixture result.");
  await local.getByTestId("v4-composer-send").click();
  await local
    .getByText("edition model fixture finished", { exact: true })
    .first()
    .waitFor({ timeout: 60000 });
  await until("local task completed", () => local.getByTestId("v4-composer-send").isVisible());
  assert.ok(counts.model > 0, "real native CLI must reach the Host broker and managed gateway");
  stage = "native-platform-agent-tier-selection";
  const beforeSelection = await runtimeCommand(local, "getZhiliuRuntimeSelection");
  assert.deepEqual(beforeSelection.selection, {
    agent_id: null,
    inference_profile_id: null,
  });
  assert.equal(beforeSelection.catalog.agents[0].name, "PPT助手");
  assert.equal(beforeSelection.catalog.inference_profiles[0].name, "深入思考");
  const selected = await runtimeCommand(local, "setZhiliuRuntimeSelection", {
    ...selectionTarget,
    selection: {
      agent_id: fixtureAgentId,
      inference_profile_id: fixtureTierId,
    },
  });
  assert.deepEqual(selected.selection, {
    agent_id: fixtureAgentId,
    inference_profile_id: fixtureTierId,
  });
  const otherWorkspace = await runtimeCommand(local, "getZhiliuRuntimeSelection", {
    ...selectionTarget,
    workspaceIdentity: "other-smoke-workspace",
  });
  assert.deepEqual(otherWorkspace.selection, {
    agent_id: null,
    inference_profile_id: null,
  });
  assert.ok(
    !/dl_|rg_|gateway_base_url|capabilityToken/.test(JSON.stringify(selected)),
    "Renderer may receive only the safe catalog projection",
  );
  stage = "isolated-cloud-session";
  let cloud = await openCloud(local);
  const bridge = await cloud.evaluate(() => ({
    zcode: typeof window.zcode,
    desktop: typeof window.desktop,
    node: typeof window.require,
    process: typeof window.process,
  }));
  assert.deepEqual(bridge, {
    zcode: "undefined",
    desktop: "undefined",
    node: "undefined",
    process: "undefined",
  });
  assert.equal(cloud.url(), `${origin}/#/agent`, "ticket must be removed from the page URL");
  assert.equal(counts.consume, 1);
  assert.equal((await cloudCookies()).length, 1);
  assert.equal(
    (await consumeTicket([...tickets.keys()][0])).status,
    409,
    "bootstrap ticket is single use",
  );

  stage = "cloud-singleton-and-local-navigation";
  await cloud.getByRole("textbox", { name: "draft" }).fill("saved draft");
  const priorBootstrap = counts.bootstrap;
  await local.getByTestId("zhiliu-open-cloud").click();
  await until("singleton focus command", () => counts.bootstrap > priorBootstrap);
  await until("singleton focus completed", () =>
    local.getByTestId("zhiliu-open-cloud").isEnabled(),
  );
  assert.equal(app.windows().length, 2);
  assert.equal(counts.consume, 1, "focusing existing cloud must preserve its web session");
  assert.equal(await cloud.getByRole("textbox", { name: "draft" }).inputValue(), "saved draft");
  await cloud.close();
  await until("closed cloud leaves local Host", () => app.windows().length === 1);
  await local.getByTestId("zhiliu-open-local").click();
  await local.getByTestId("zhiliu-workspace-switcher").waitFor();
  cloud = await openCloud(local);
  await cloud.getByRole("textbox", { name: "draft" }).fill("cancel keeps draft");
  await cloudCookies();

  stage = "logout-default-cancel";
  const accountControls = local.getByTestId("zhiliu-account-controls");
  await accountControls.getByRole("button", { name: "退出登录", exact: true }).click();
  await until("cancel logout completed", () =>
    accountControls.getByRole("button", { name: "退出登录", exact: true }).isEnabled(),
  );
  const cancelledDialog = await app.evaluate(() =>
    globalThis.__zhiliuEditionSmoke.dialogs.find((entry) => entry.title === "退出织流"),
  );
  assert.equal(cancelledDialog.defaultId, 0);
  assert.equal(cancelledDialog.cancelId, 0);
  assert.deepEqual(cancelledDialog.buttons, ["取消", "退出登录"]);
  assert.match(cancelledDialog.detail, /网页将无法控制这台电脑执行任务/u);
  assert.equal(counts.logout, 0);
  assert.equal(app.windows().length, 2);
  assert.equal((await credentialFiles()).length, 1);
  assert.equal(
    await cloud.getByRole("textbox", { name: "draft" }).inputValue(),
    "cancel keeps draft",
  );

  stage = "confirmed-logout-clears-session";
  await app.evaluate(() => {
    globalThis.__zhiliuEditionSmoke.logoutResponses.push(1);
  });
  await accountControls.getByRole("button", { name: "退出登录", exact: true }).click();
  await accountControls.getByRole("button", { name: "登录织流", exact: true }).waitFor();
  await until("logout closes cloud", () => app.windows().length === 1);
  assert.equal(counts.logout, 1);
  assert.equal((await credentialFiles()).length, 0);
  assert.deepEqual(await cloudCookies(), []);
  const unusedTicket = [...tickets].find(([, value]) => !value.consumed)[0];
  assert.equal(
    (await consumeTicket(unusedTicket)).status,
    410,
    "logout invalidates unused grant-bound tickets",
  );

  stage = "relogin-after-logout";
  await signIn(local);
  assert.deepEqual(
    (await runtimeCommand(local, "getZhiliuRuntimeSelection")).selection,
    { agent_id: null, inference_profile_id: null },
    "sign-out must clear the previous account's workspace selection",
  );
  cloud = await openCloud(local);
  assert.deepEqual(await cloud.evaluate(() => window.fixtureBeforeLogin), {
    local: null,
    session: null,
  });
  await cloudCookies();
  stage = "server-session-invalidation";
  [...grants.values()].find((grant) => !grant.revoked).invalid = true;
  const beforeInvalidationBootstrap = counts.bootstrap;
  await local.getByTestId("zhiliu-open-cloud").click();
  await until("invalid session closes cloud", () => app.windows().length === 1);
  await accountControls
    .getByRole("button", { name: "登录织流", exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    counts.bootstrap,
    beforeInvalidationBootstrap,
    "invalid account cannot mint a bootstrap ticket",
  );
  assert.equal((await credentialFiles()).length, 0);
  assert.deepEqual(await cloudCookies(), []);
  assert.deepEqual(fixtureErrors, []);
  const dialogTitles = await app.evaluate(() =>
    globalThis.__zhiliuEditionSmoke.dialogs.map((entry) => entry.title),
  );
  assert.ok(dialogTitles.every((title) => ["登录织流", "退出织流"].includes(title)));
  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      checks: [
        "brand and first-run login without personal key form",
        "browser authorization pending, PKCE and device proof",
        "sealed native account credential",
        "first login rewarms the existing Host runtime without restarting",
        "native UI task reaches the real CLI and private Host model broker",
        "native safe Agent/tier catalog and per-workspace selection cleared by logout",
        "single-use cloud bootstrap without native token exposure",
        "isolated cloud window without native bridge",
        "singleton preserves session and draft",
        "cloud close keeps local Host and navigation",
        "logout defaults to cancel and preserves account and cloud",
        "confirmed logout clears credential, cloud window and partition",
        "relogin starts without previous web storage",
        "server session invalidation clears local account and cloud",
      ],
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`Edition smoke failed at ${stage}\n`);
  if (app) {
    for (const window of app.windows()) {
      if (window.isClosed()) continue;
      process.stderr.write(
        `${JSON.stringify(
          await window
            .evaluate(() => ({
              title: document.title,
              path: new URL(location.href).pathname,
              body: document.body.innerText.slice(0, 4000),
              editable: [...document.querySelectorAll("[contenteditable], textarea, input")].map(
                (node) => ({
                  tag: node.tagName,
                  testId: node.getAttribute("data-testid"),
                  role: node.getAttribute("role"),
                }),
              ),
              bridge: typeof window.zcode,
            }))
            .catch(() => ({ stage: "renderer-unavailable" })),
        )}\n`,
      );
    }
  }
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
  assert.equal(dirname(scratch), resolve(tmpdir()));
  assert.ok(scratch.startsWith(join(tmpdir(), "zhiliu-edition-smoke-")));
  await rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}
