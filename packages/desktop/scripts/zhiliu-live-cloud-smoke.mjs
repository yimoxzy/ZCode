import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { resolveZhiliuCloudTarget } from "../src/main/zhiliuCloudPolicy.ts";

// 只检查真实服务的未登录入口和 readiness，不创建账号、不发起付费推理。
const target = resolveZhiliuCloudTarget(process.env.ZHILIU_CLOUD_URL);
const require = createRequire(import.meta.url);
const desktopRoot = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "zhiliu-live-cloud-"));
const env = {
  ...process.env,
  ZCODE_DATA_BASE_DIR: join(scratch, "data"),
  ZCODE_DESKTOP_HOME_DIR: scratch,
  ZCODE_DESKTOP_USER_DATA_DIR: join(scratch, "profile"),
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZHILIU_CLOUD_URL: target.url,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [desktopRoot],
    cwd: desktopRoot,
    env,
    timeout: 60_000,
  });
  const local = await app.firstWindow({ timeout: 60_000 });
  await local.getByTestId("root-startup-loading").waitFor({ state: "hidden", timeout: 60_000 });
  await local.getByTestId("zhiliu-workspace-switcher").waitFor();
  const [cloud] = await Promise.all([
    app.waitForEvent("window", { timeout: 30_000 }),
    local.getByTestId("zhiliu-open-cloud").click(),
  ]);
  await cloud.locator('input[type="password"]').waitFor({ timeout: 30_000 });
  const result = await cloud.evaluate(async () => ({
    origin: location.origin,
    nativeBridge: typeof window.zcode,
    node: typeof window.require,
    ready: await fetch("/api/ready").then((response) => response.json()),
  }));
  assert.equal(result.origin, target.origin);
  assert.equal(result.nativeBridge, "undefined");
  assert.equal(result.node, "undefined");
  assert.equal(result.ready.status, "ready");
  assert.equal(result.ready.worker, "ready");
  if (process.env.ZHILIU_SMOKE_SCREENSHOT) {
    await cloud.screenshot({ path: process.env.ZHILIU_SMOKE_SCREENSHOT });
  }
  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      checks: [
        "application startup",
        "real SaaS sign-in form",
        "API and worker ready",
        "no native bridge on SaaS page",
      ],
      version: result.ready.version,
      schema: result.ready.schema.current,
    })}\n`,
  );
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
