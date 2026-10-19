import { DesktopCommandIds, type DesktopCommandId } from "@zcode/shared";

export function buildZhiliuAccountMenu(
  execute: (command: DesktopCommandId) => Promise<unknown>,
): Electron.MenuItemConstructorOptions {
  return {
    label: "织流账号",
    submenu: [
      {
        label: "浏览器授权登录…",
        click: () => void execute(DesktopCommandIds.LoginZhiliu).catch(() => undefined),
      },
      {
        label: "取消登录授权",
        click: () => void execute(DesktopCommandIds.CancelZhiliuLogin).catch(() => undefined),
      },
      { type: "separator" },
      {
        label: "退出登录…",
        click: () => void execute(DesktopCommandIds.LogoutZhiliu).catch(() => undefined),
      },
    ],
  };
}
