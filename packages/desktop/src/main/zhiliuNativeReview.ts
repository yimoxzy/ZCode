import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";

const escapeHtml = (value: string) =>
  value
    .replace(
      /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .replace(
      /[&<>"']/gu,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );

/** 无脚本/Node/preload的本机完整文本预览；云端不能创建或回答此窗口。 */
export function showZhiliuNativeReview(
  kind: "operation" | "result",
  title: string,
  detail: string,
): { answer: Promise<string>; close: () => void } {
  const id = randomUUID(),
    prefix = `https://zhiliu.invalid/review/${id}/`;
  const partition = `zhiliu-review-${id}`,
    nativeSession = session.fromPartition(partition);
  nativeSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  nativeSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: 740,
    height: 620,
    minWidth: 560,
    minHeight: 440,
    title,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const fallback = kind === "operation" ? "reject" : "summary";
  // 每项固定为动作/文案元组，严格索引检查下也不允许 undefined 进入审批结果。
  const choices: ReadonlyArray<readonly [string, string]> =
    kind === "operation"
      ? [
          ["reject", "拒绝"],
          ["approve", "允许这一次"],
        ]
      : [
          ["summary", "只发送执行摘要"],
          ["content", "发送以上完整内容"],
        ];
  let settle: (value: string) => void = () => {};
  const answer = new Promise<string>((resolve) => {
    settle = resolve;
  });
  let done = false;
  const finish = (value: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    settle(value);
    if (!window.isDestroyed()) window.destroy();
  };
  const timer = setTimeout(() => finish(fallback), 180000);
  window.on("closed", () => finish(fallback));
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    const choice = choices.find(([key]) => url === prefix + key);
    if (choice) finish(choice[0]);
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f7f8fa;color:#20252b;font:14px system-ui}main{padding:24px;height:calc(100vh - 48px);box-sizing:border-box;display:flex;flex-direction:column;gap:16px}h1{font-size:19px;margin:0}pre{flex:1;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #dce1e8;border-radius:10px;padding:18px;margin:0;font:13px/1.65 Consolas,monospace}nav{display:flex;justify-content:flex-end;gap:12px}a{padding:10px 18px;border:1px solid #bdc7d4;border-radius:8px;background:white;color:#24334b;text-decoration:none}a:last-child{background:#295bc7;color:white;border-color:#295bc7}small{color:#596779}</style><main><h1>${escapeHtml(title)}</h1><small>织流本机确认 · 只对当前请求有效</small><pre>${escapeHtml(detail)}</pre><nav>${choices.map(([key, label], i) => `<a ${i === 0 ? "autofocus" : ""} href="${prefix}${key}">${label}</a>`).join("")}</nav></main></html>`;
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .then(() => {
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
      }
    })
    .catch(() => finish(fallback));
  return { answer, close: () => finish(fallback) };
}
