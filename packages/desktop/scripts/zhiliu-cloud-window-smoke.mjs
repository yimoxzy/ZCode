import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electronExecutable from "electron";

// 使用真实 Electron 而非 BrowserWindow mocks；不启动上游服务，不访问外网，不触发系统下载对话框。
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = await mkdtemp(join(tmpdir(), "zhiliu-cloud-smoke-"));
const page =
  "<!doctype html><title>Untrusted page title</title><body><h1>Cloud fixture</h1></body>";
let externalRequests = 0;
const server = createServer((request, response) => {
  if (request.url === "/escape") {
    response.writeHead(302, { Location: `http://localhost:${server.address().port}/foreign` });
    response.end();
    return;
  }
  if (request.url === "/foreign") externalRequests += 1;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(page);
});

const harness = `
import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { openZhiliuCloudWindow } from "./cloud-window.mjs";
const origin = process.env.ZHILIU_SMOKE_ORIGIN;
let stage = "app-ready";
const timeout = setTimeout(() => { console.error("cloud smoke timed out at " + stage); app.exit(1); }, 20000);
app.setPath("userData", process.env.ZHILIU_SMOKE_DATA);
app.on("window-all-closed", () => {});
async function run() {
  await app.whenReady();
  stage = "open-cloud-window";
  const win = await openZhiliuCloudWindow({ cloudUrl: origin });
  win.hide();
  stage = "bridge-boundaries";
  const boundaries = await win.webContents.executeJavaScript("({ node: typeof require, process: typeof process, zcode: typeof window.zcode, desktop: typeof window.desktop })");
  assert.deepEqual(boundaries, { node: "undefined", process: "undefined", zcode: "undefined", desktop: "undefined" });
  assert.equal(win.getTitle(), "织流 · 云 Agent");
  const prefs = win.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webviewTag, false);
  const again = await openZhiliuCloudWindow({ cloudUrl: origin + "/#/knowledge" });
  assert.equal(again, win);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  const popupResult = await win.webContents.executeJavaScript("window.open('https://escape.invalid') === null", true);
  assert.equal(popupResult, true);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  stage = "permissions";
  const permissions = await win.webContents.executeJavaScript("Promise.all(['notifications', 'camera', 'microphone'].map(name => navigator.permissions.query({name}).then(value => value.state)))");
  assert.deepEqual(permissions, ["denied", "denied", "denied"]);
  const initialUrl = win.webContents.getURL();
  stage = "cross-origin-navigation";
  const blocked = new Promise(resolve => win.webContents.once("will-frame-navigate", event => resolve(event.defaultPrevented)));
  await win.webContents.executeJavaScript("location.href = 'http://localhost:' + location.port + '/foreign'; undefined");
  assert.equal(await blocked, true);
  assert.equal(win.webContents.getURL(), initialUrl);
  stage = "cross-origin-redirect";
  const blockedRedirect = new Promise(resolve => win.webContents.once("will-redirect", event => resolve(event.defaultPrevented)));
  try { await win.loadURL(origin + "/escape"); } catch {}
  assert.equal(await blockedRedirect, true);
  await win.loadURL(origin);
  stage = "download";
  const download = new Promise((resolve, reject) => {
    win.webContents.session.once("will-download", (_event, item) => {
      try {
        assert.equal(item.getSavePath(), "");
        assert.equal(item.getSaveDialogOptions().title, "保存织流文件");
        assert.equal(item.getSaveDialogOptions().defaultPath, "report.txt");
        item.cancel();
        resolve(true);
      } catch (error) { item.cancel(); reject(error); }
    });
  });
  await win.webContents.executeJavaScript("const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(['fixture'])); link.download = 'report.txt'; document.body.appendChild(link); link.click(); undefined", true);
  await download;
  const cloudSession = win.webContents.session;
  assert.equal(cloudSession.listenerCount("will-download"), 1);
  win.destroy();
  assert.equal(cloudSession.listenerCount("will-download"), 0);
  console.log(JSON.stringify({ ok: true, checks: ["no-privileged-bridge", "sandbox", "singleton", "popup-denied", "permissions-denied", "cross-origin-navigation-denied", "cross-origin-redirect-denied", "download-save-dialog", "listener-cleanup"] }));
}
run().then(() => { clearTimeout(timeout); app.exit(0); }).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
`;

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await build({
    entryPoints: [join(repositoryRoot, "packages/desktop/src/main/zhiliuCloudWindow.ts")],
    outfile: join(scratch, "cloud-window.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    logLevel: "silent",
  });
  await writeFile(join(scratch, "main.mjs"), harness);
  const childEnvironment = {
    ...process.env,
    ZHILIU_SMOKE_ORIGIN: `http://127.0.0.1:${server.address().port}`,
    ZHILIU_SMOKE_DATA: join(scratch, "profile"),
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExecutable, [join(scratch, "main.mjs")], {
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (value) => process.stdout.write(value));
  child.stderr.on("data", (value) => process.stderr.write(value));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "real Electron cloud-window smoke failed");
  assert.equal(externalRequests, 0, "blocked destination must not receive an HTTP request");
} finally {
  server.closeAllConnections();
  server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  assert.ok(scratch.startsWith(join(tmpdir(), "zhiliu-cloud-smoke-")));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
