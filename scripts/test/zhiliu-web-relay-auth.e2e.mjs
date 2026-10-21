// 生产 Web + 真实薄 Relay 的浏览器身份/配对验收；SaaS issuer 和 Desktop socket 为受控夹具。
// 运行：ZHILIU_DESKTOP=1 pnpm --filter @zcode/web exec vite build --base=/remote/v4/
//       node --import tsx scripts/test/zhiliu-web-relay-auth.e2e.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { WebSocket, WebSocketServer } from "ws";
import { createZhiliuRelay } from "../../packages/zhiliu-relay/src/index.ts";
import { exampleRelayPrincipal } from "../../packages/zhiliu-relay/src/contract.example.ts";

const assetRoot = resolve("packages/web/dist");
const terminalGrant = "rc_" + "t".repeat(64);
const deviceGrant = "rc_" + "d".repeat(64);
const principal = {
  ...exampleRelayPrincipal,
  expires_at: new Date(Date.now() + 300_000).toISOString(),
};
const terminalPrincipal = {
  ...principal,
  role: "terminal",
  device_mid: null,
  desktop_device_id: null,
};
const requests = [];
const errors = [];
const external = [];
const proxiedSockets = new Set();
let relay;
let origin;
let logoutCount = 0;
let acceptedRoot = true;
let bootstraps = 0;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === "/api/desktop-relay/terminal-grants") {
      requests.push({ kind: "grant", authorization: req.headers.authorization });
      assert.equal(req.headers.authorization, "Bearer e2e-saas-access");
      const bytes = [];
      for await (const part of req) bytes.push(part);
      assert.deepEqual(JSON.parse(Buffer.concat(bytes).toString()), {});
      res.writeHead(acceptedRoot ? 201 : 401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify(
          acceptedRoot
            ? {
                protocol_version: 1,
                relay_grant: terminalGrant,
                expires_at: new Date(Date.now() + 300_000).toISOString(),
                principal_id: principal.principal_id,
                desktop_device_id: null,
              }
            : { detail: "signed out" },
        ),
      );
      return;
    }
    if (url.pathname === "/api/auth/logout") {
      logoutCount++;
      acceptedRoot = false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname.startsWith("/api/v1/remote/")) {
      assert.equal(req.headers.authorization, `Bearer ${terminalGrant}`);
      requests.push({ kind: url.pathname.endsWith("/token") ? "token" : "devices" });
      const bytes = [];
      for await (const part of req) bytes.push(part);
      const headers = { ...req.headers };
      delete headers.host;
      const response = await fetch(relay.httpUrl + url.pathname, {
        method: req.method,
        headers,
        ...(bytes.length ? { body: Buffer.concat(bytes) } : {}),
      });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>织流登录测试页</h1>");
      return;
    }
    const relative = url.pathname.replace(/^\/remote\/v4\/?/u, "");
    const path = resolve(assetRoot, relative || "index.html");
    assert.ok(path === assetRoot || path.startsWith(assetRoot + sep));
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    res.end(await readFile(path));
  } catch {
    errors.push("fixture HTTP boundary failed");
    res.writeHead(500);
    res.end();
  }
});
const socketProxy = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  assert.ok(!req.url.includes(terminalGrant) && !req.url.includes("e2e-saas-access"));
  socketProxy.handleUpgrade(req, socket, head, (browserSocket) => {
    const target = new WebSocket(relay.wsUrl + new URL(req.url, origin).search);
    const pending = [];
    proxiedSockets.add(browserSocket);
    proxiedSockets.add(target);
    browserSocket.on("message", (data) =>
      target.readyState === WebSocket.OPEN
        ? target.send(data.toString())
        : pending.push(data.toString()),
    );
    target.on("open", () => {
      for (const data of pending) target.send(data);
    });
    target.on("message", (data) => {
      if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data.toString());
    });
    browserSocket.on("close", () => target.close());
    target.on("close", () => browserSocket.close());
    target.on("error", () => browserSocket.close());
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let device;
try {
  relay = await createZhiliuRelay({
    publicOrigin: origin,
    introspect: async (grant) => {
      if (grant === deviceGrant) return principal;
      if (grant === terminalGrant && acceptedRoot) return terminalPrincipal;
      throw new Error("authorization rejected");
    },
  });
  const deviceHeaders = {
    Authorization: `Bearer ${deviceGrant}`,
    "Content-Type": "application/json",
  };
  const deviceRecord = (
    await (
      await fetch(relay.httpUrl + "/api/v1/remote/device", {
        method: "POST",
        headers: deviceHeaders,
        body: JSON.stringify({ device_mid: principal.device_mid }),
      })
    ).json()
  ).data;
  const wsToken = (
    await (
      await fetch(relay.httpUrl + "/api/v1/remote/token", {
        method: "POST",
        headers: deviceHeaders,
        body: JSON.stringify({ role: "device" }),
      })
    ).json()
  ).data.token;
  device = new WebSocket(relay.wsUrl + `?token=${wsToken}`);
  device.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "data" && frame.payload?.zcode_type === "bootstrap-request") bootstraps++;
  });
  await new Promise((resolve) =>
    device.on("open", () => {
      device.send(
        JSON.stringify({
          type: "auth_init",
          device_sid: deviceRecord.device_sid,
          meta: { name: "浏览器验收电脑", platform: "win32", version: "3.16.2" },
        }),
      );
      resolve();
    }),
  );
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push(new URL(route.request().url()).origin);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/remote/v4");
  await page.getByRole("heading", { name: "织流登录测试页" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("next"), "/remote/v4");
  assert.equal(requests.length, 0);
  await context.addInitScript(() => {
    sessionStorage.setItem("access_token", "e2e-saas-access");
    sessionStorage.setItem("refresh_token", "e2e-saas-refresh");
  });
  await page.goto(origin + "/remote/v4");
  const desktopButton = page.getByRole("button", { name: /浏览器验收电脑/u });
  await desktopButton.waitFor().catch(async (error) => {
    console.log(
      JSON.stringify({
        location: page.url(),
        body: await page.locator("body").innerText(),
        errors,
        external,
        requestKinds: requests.map((item) => item.kind),
      }),
    );
    throw error;
  });
  assert.equal(requests.filter((item) => item.kind === "grant").length, 1);
  assert.match(await page.title(), /织流/u);
  assert.equal(await page.locator('link[rel="icon"]').count(), 1);
  assert.match(
    decodeURIComponent(await page.locator('link[rel="icon"]').getAttribute("href")),
    /#24839b/u,
  );
  assert.equal(requests.filter((item) => item.kind === "devices").length, 1);
  assert.deepEqual(
    await page.evaluate(() =>
      Object.values({ ...localStorage, ...sessionStorage }).filter((value) =>
        value.startsWith("rc_"),
      ),
    ),
    [],
  );
  await page.getByRole("button", { name: "切换账号", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(logoutCount, 0);
  await desktopButton.click();
  const deadline = Date.now() + 10_000;
  while (!bootstraps && Date.now() < deadline) await delay(25);
  assert.equal(bootstraps, 1, "原 V4 shell 必须通过真实 relay 向既有 Desktop socket 发 bootstrap");
  assert.match(await page.title(), /织流/u);
  assert.equal(requests.filter((item) => item.kind === "token").length, 1);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: production Web / SaaS Bearer issuer / real Relay / existing V4 bootstrap; no external OAuth or persisted rc_.",
  );
} finally {
  await browser?.close();
  device?.terminate();
  for (const socket of proxiedSockets) socket.terminate();
  await new Promise((resolve) => socketProxy.close(resolve));
  await relay?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
