import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "zhiliu-edition-smoke-"));
const home = join(scratch, "home");
await mkdir(home);
const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><title>Cloud fixture</title><h1>织流云工作台验收</h1><input aria-label="draft" />',
  );
});
await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
const cloudUrl = `http://127.0.0.1:${fixture.address().port}/`;
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USER_DATA_DIR: join(scratch, "profile"),
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZHILIU_CLOUD_URL: cloudUrl,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ZCODE_DATA_BASE_DIR;
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [desktopRoot],
    cwd: desktopRoot,
    env,
    timeout: 60_000,
  });
  app.process().stderr?.pipe(process.stderr);
  const local = await app.firstWindow({ timeout: 60_000 });
  await local.getByTestId("zhiliu-workspace-switcher").waitFor({ timeout: 60_000 });
  await local.getByTestId("root-startup-loading").waitFor({ state: "hidden", timeout: 60_000 });
  assert.equal(await app.evaluate(({ app }) => app.getName()), "织流");
  await local.getByTestId("zhiliu-cloud-access-notice").first().waitFor();
  assert.equal(await local.locator('input[type="password"]').count(), 0);
  assert.equal(await local.getByRole("button", { name: "登录云 Agent", exact: true }).count(), 1);
  await local.screenshot({
    path: process.env.ZHILIU_SMOKE_SCREENSHOT || join(scratch, "local.png"),
  });
  const [cloud] = await Promise.all([
    app.waitForEvent("window", { timeout: 30_000 }),
    local.getByTestId("zhiliu-open-cloud").click(),
  ]);
  await cloud.getByRole("heading", { name: "织流云工作台验收" }).waitFor();
  const bridge = await cloud.evaluate(() => ({
    zcode: typeof window.zcode,
    desktop: typeof window.desktop,
    node: typeof window.require,
  }));
  assert.deepEqual(bridge, { zcode: "undefined", desktop: "undefined", node: "undefined" });
  await cloud.getByRole("textbox", { name: "draft" }).fill("saved draft");
  await local.getByTestId("zhiliu-open-cloud").click();
  assert.equal(app.windows().length, 2);
  assert.equal(await cloud.getByRole("textbox", { name: "draft" }).inputValue(), "saved draft");
  await cloud.close();
  assert.equal(app.windows().length, 1);
  await local.getByTestId("zhiliu-open-local").click();
  await local.getByTestId("zhiliu-workspace-switcher").waitFor();
  process.stdout.write(
    JSON.stringify({
      passed: true,
      checks: [
        "brand",
        "first-run platform login entry without personal model/key form",
        "local inference unavailable until platform authorization gateway is delivered",
        "real command to isolated cloud window",
        "no native bridge",
        "singleton preserves draft",
        "cloud close keeps local Host window",
        "local navigation",
      ],
    }) + "\n",
  );
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await new Promise((done) => fixture.close(done));
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
