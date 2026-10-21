// 受控本机交互：先以 ZHILIU_DESKTOP=1 启动 Web，再运行本脚本。
// 只验证登记发现、真实 relay SID 边界及刷新，不替代真实 Desktop Host 联合验收。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const origin = process.env.ZHILIU_DISCOVERY_E2E_ORIGIN || "http://127.0.0.1:5199";
const artifacts = resolve(".tmp/zhiliu-device-discovery-e2e");
const principal = "11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const device = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "E2E registered computer",
  platform: "win32",
  status: "active",
  revoked_at: null,
  // 即使原生心跳在线，也不能变成可选择的 relay 连接。
  online: true,
  workspace_ready: true,
};
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const width of [390, 1024]) {
    for (const locale of ["zh-CN", "en-US"]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, locale });
      const page = await context.newPage();
      const errors = [];
      const unexpected = [];
      const traffic = { grants: 0, devices: 0, relay: 0, tokens: 0, sockets: 0 };
      let mode = "registered";
      page.on("pageerror", (error) => errors.push(error.message));
      await context.addInitScript(() => {
        sessionStorage.setItem("access_token", "e2e-saas-access");
        sessionStorage.setItem("refresh_token", "e2e-saas-refresh");
      });
      await context.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (!path.startsWith("/api/")) return route.continue();
        if (path === "/api/desktop-relay/terminal-grants") {
          traffic.grants++;
          assert.equal(request.headers().authorization, "Bearer e2e-saas-access");
          return route.fulfill({
            json: {
              protocol_version: 1,
              relay_grant: "rc_" + "a".repeat(64),
              principal_id: principal,
              desktop_device_id: null,
              expires_at: new Date(Date.now() + 300_000).toISOString(),
            },
          });
        }
        if (path === "/api/devices") {
          traffic.devices++;
          assert.equal(request.method(), "GET");
          assert.equal(request.headers().authorization, "Bearer e2e-saas-access");
          return route.fulfill({
            status: mode === "failure" ? 503 : 200,
            json:
              mode === "revoked"
                ? [{ ...device, status: "revoked", revoked_at: new Date().toISOString() }]
                : [device],
          });
        }
        if (path === "/api/v1/remote/device") {
          traffic.relay++;
          assert.equal(request.headers().authorization, "Bearer rc_" + "a".repeat(64));
          const records =
            mode === "online"
              ? [
                  {
                    device_sid: "real-relay-sid",
                    device_mid: device.id,
                    online: true,
                    created_at: 1,
                    meta: { name: "E2E online computer", platform: "win32", version: "3.15.0" },
                  },
                ]
              : [];
          return route.fulfill({ json: { code: 0, msg: "", data: records } });
        }
        if (path === "/api/v1/remote/token") traffic.tokens++;
        unexpected.push(path);
        return route.fulfill({ status: 500, json: {} });
      });
      await context.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, () => {
        traffic.sockets++;
      });
      try {
        await page.goto(`${origin}/remote/v4`);
        const rows = page.locator("main li");
        await page.getByText(device.name, { exact: true }).waitFor();
        assert.equal(await rows.count(), 1);
        assert.equal(await rows.first().getByRole("button").isDisabled(), true);
        assert.match(
          await rows.first().innerText(),
          /已登记，远控未连接|Registered, remote control disconnected/,
        );
        assert.equal(await page.locator("main .bg-success").count(), 0);
        assert.equal(traffic.tokens, 0);
        assert.equal(traffic.sockets, 0);
        await page.screenshot({
          path: resolve(artifacts, `registered-${width}-${locale}.png`),
          fullPage: true,
        });

        const refresh = page.getByRole("button", { name: /^(刷新|Refresh)$/ }).first();
        mode = "online";
        await refresh.click();
        await page.getByText("E2E online computer", { exact: true }).waitFor();
        assert.equal(await rows.count(), 1);
        assert.equal(await rows.first().getByRole("button").isDisabled(), false);
        assert.equal(traffic.tokens, 0);

        mode = "revoked";
        await refresh.click();
        await page.getByText(/^(暂无设备|No devices yet)$/).waitFor();
        assert.equal(await rows.count(), 0);
        assert.equal(
          await page.evaluate(() => localStorage.getItem("zcode-web-remote-device-names")),
          null,
        );

        mode = "failure";
        await refresh.click();
        await page.getByRole("alert").waitFor();
        assert.equal(
          await page.evaluate(() => sessionStorage.getItem("access_token")),
          "e2e-saas-access",
        );
        assert.equal(traffic.tokens, 0);
        assert.equal(traffic.sockets, 0);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        results.push({ width, locale, result: "passed", traffic });
      } catch (error) {
        await page.screenshot({
          path: resolve(artifacts, `failure-${width}-${locale}.png`),
          fullPage: true,
        });
        console.error(
          JSON.stringify({
            width,
            locale,
            traffic,
            errors,
            unexpected,
            body: (await page.locator("body").innerText()).slice(0, 1800),
          }),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  }
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
