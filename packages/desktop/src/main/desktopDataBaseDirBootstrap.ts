import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataBaseDir, resolveDefaultDataBaseDir, setDataBaseDir } from "@zcode/services/node";

export function resolveBootstrapSettingsFile(
  homePath: string = process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    homedir(),
): string {
  return join(resolveDefaultDataBaseDir(homePath), ".zcode", "v2", "setting.json");
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const currentBaseDir = getDataBaseDir();
  if (process.env.ZCODE_DATA_BASE_DIR?.trim() || currentBaseDir !== resolveDefaultDataBaseDir()) {
    // 显式运维目录和已注入的根优先，旧启动设置不能悄悄把实例重新指向其他数据。
    return currentBaseDir;
  }
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
