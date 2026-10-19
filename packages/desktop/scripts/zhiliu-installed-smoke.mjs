import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { resolveZhiliuCloudTarget } from "../src/main/zhiliuCloudPolicy.ts";

// Windows 发布包关闭 Main Inspector；通过独立临时 profile 的 Chromium CDP 验收，不能翻转发布 fuse。
const executable = process.env.ZHILIU_SMOKE_EXECUTABLE;
if (!executable) throw new Error("Set ZHILIU_SMOKE_EXECUTABLE to the installed application");
const scratch = await mkdtemp(join(tmpdir(), "zhiliu-installed-"));
const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<h1>织流安装验收</h1><input aria-label="draft" />');
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const live = Boolean(process.env.ZHILIU_CLOUD_URL?.trim());
const target = resolveZhiliuCloudTarget(
  process.env.ZHILIU_CLOUD_URL || `http://127.0.0.1:${fixture.address().port}/`,
);
const env = {
  ...process.env,
  ZCODE_DATA_BASE_DIR: join(scratch, "data"),
  ZCODE_DESKTOP_HOME_DIR: scratch,
  ZCODE_DESKTOP_USER_DATA_DIR: join(scratch, "profile"),
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZHILIU_CLOUD_URL: target.url,
};
delete env.ELECTRON_RUN_AS_NODE;
let child;
let browser;
try {
  child = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Chromium CDP startup timed out")), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Installed application exited before CDP: ${code}`));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-32_768);
      const found =
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/u.exec(stderr);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const local = context.pages()[0] || (await context.waitForEvent("page"));
  await local.getByTestId("zhiliu-workspace-switcher").waitFor({ timeout: 60_000 });
  await local.getByTestId("root-startup-loading").waitFor({ state: "hidden", timeout: 60_000 });
  await local.getByTestId("zhiliu-cloud-access-notice").first().waitFor();
  assert.equal(await local.locator('input[type="password"]').count(), 0);
  const [cloud] = await Promise.all([
    context.waitForEvent("page", { timeout: 30_000 }),
    local.getByTestId("zhiliu-open-cloud").click(),
  ]);
  const checks = [
    "installed startup without Main Inspector",
    "platform login entry",
    "no personal model/key form",
  ];
  let readiness;
  if (live) {
    try {
      await cloud.locator('input[type="password"]').waitFor({ timeout: 60_000 });
    } catch (error) {
      if (process.env.ZHILIU_SMOKE_SCREENSHOT && !cloud.isClosed()) {
        await cloud.screenshot({ path: `${process.env.ZHILIU_SMOKE_SCREENSHOT}.failure.png` });
      }
      process.stderr.write(
        `${JSON.stringify({
          stage: "SaaS sign-in",
          closed: cloud.isClosed(),
          title: cloud.isClosed() ? null : await cloud.title(),
          fields: cloud.isClosed() ? null : await cloud.locator("input").count(),
        })}\n`,
      );
      throw error;
    }
    readiness = await cloud.evaluate(() => fetch("/api/ready").then((response) => response.json()));
    assert.equal(readiness.status, "ready");
    assert.equal(readiness.worker, "ready");
    checks.push("real SaaS login form", "API and worker ready");
  } else {
    await cloud.getByRole("heading", { name: "织流安装验收" }).waitFor();
    await cloud.getByRole("textbox", { name: "draft" }).fill("saved draft");
    await local.getByTestId("zhiliu-open-cloud").click();
    assert.equal(context.pages().length, 2);
    assert.equal(await cloud.getByRole("textbox", { name: "draft" }).inputValue(), "saved draft");
    checks.push("singleton keeps draft");
  }
  assert.equal(new URL(cloud.url()).origin, target.origin);
  assert.deepEqual(
    await cloud.evaluate(() => ({
      zcode: typeof window.zcode,
      desktop: typeof window.desktop,
      node: typeof window.require,
    })),
    { zcode: "undefined", desktop: "undefined", node: "undefined" },
  );
  checks.push("SaaS window has no native bridge");
  if (process.env.ZHILIU_SMOKE_SCREENSHOT) {
    await (live ? cloud : local).screenshot({ path: process.env.ZHILIU_SMOKE_SCREENSHOT });
  }
  await cloud.close();
  assert.equal(local.isClosed(), false);
  await local.getByTestId("zhiliu-workspace-switcher").waitFor();
  checks.push("closing cloud preserves local window");
  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      live,
      checks,
      version: readiness?.version,
      schema: readiness?.schema.current,
    })}\n`,
  );
} finally {
  await browser?.close().catch(() => {});
  // 仅终止本测试亲自启动的独立 profile 进程树，不搜索/关闭用户其他窗口。
  if (child?.pid && child.exitCode === null) {
    if (process.platform === "win32") {
      await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(
        () => {},
      );
    } else child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  }
  await new Promise((resolve) => fixture.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
