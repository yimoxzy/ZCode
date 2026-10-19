import { app } from "electron";
import type { BrowserWindow } from "electron";
import { join } from "node:path";
import { ZHILIU_DESKTOP_ENABLED, type ResourceUsageProcess } from "@zcode/shared";

export const RESOURCE_MANAGER_WINDOW_TITLE = ZHILIU_DESKTOP_ENABLED
  ? "织流 · 资源管理器"
  : "Resource Manager";

export function resourceManagerWindowBrandOptions() {
  if (!ZHILIU_DESKTOP_ENABLED) return {};
  return {
    icon: app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build/zhiliu/icon.png"),
  };
}

export function installResourceManagerWindowBrand(win: BrowserWindow) {
  if (ZHILIU_DESKTOP_ENABLED) {
    win.on("page-title-updated", (event) => event.preventDefault());
  }
}

/** 仅改展示投影，保留 PID、分组和进程识别契约，不重写第三方进程名称。 */
export function projectResourceManagerProcessBrand(rows: ResourceUsageProcess[]) {
  if (!ZHILIU_DESKTOP_ENABLED) return rows;
  return rows.map((row) =>
    row.category === "base" && row.name.startsWith("zcode-")
      ? { ...row, name: `zhiliu-${row.name.slice("zcode-".length)}` }
      : row,
  );
}
