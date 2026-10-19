import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brand = vi.hoisted(() => ({ enabled: true }));
const pathOwner = vi.hoisted(() => ({
  current: null as typeof import("../../services/src/paths.js") | null,
}));
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return brand.enabled;
  },
}));
// Bootstrap uses the public services entry; keep the actual path owner without starting services.
vi.mock("@zcode/services/node", () => ({
  getDataBaseDir: () => pathOwner.current!.getDataBaseDir(),
  resolveDefaultDataBaseDir: (home?: string) => pathOwner.current!.resolveDefaultDataBaseDir(home),
  setDataBaseDir: (value: string | null) => pathOwner.current!.setDataBaseDir(value),
}));

const homes: string[] = [];
function createHome() {
  const home = mkdtempSync(join(tmpdir(), "zhiliu-data-isolation-"));
  homes.push(home);
  return home;
}
function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  vi.resetModules();
  brand.enabled = true;
  vi.stubEnv("HOME", createHome());
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "");
  vi.stubEnv("ZCODE_DATA_BASE_DIR", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("zhiliu data isolation", () => {
  it("isolates provider, session and settings paths from existing ZCode files", async () => {
    const home = process.env.HOME!;
    const oldSettings = join(home, ".zcode", "v2", "setting.json");
    writeJson(oldSettings, { dataBaseDir: join(home, "old-zcode-custom"), locale: "en-US" });
    writeJson(join(home, ".zcode", "cli", "config.json"), { marker: "old-provider" });
    writeJson(join(home, ".zcode", "v2", "sessions", "old.json"), { marker: "old-session" });

    const paths = await import("../../services/src/paths.js");
    pathOwner.current = paths;
    const bootstrap = await import("../src/main/desktopDataBaseDirBootstrap.js");
    expect(paths.getDataBaseDir()).toBe(join(home, ".zhiliu-desktop"));
    expect(paths.getProviderWorkspaceConfigDir()).toBe(
      join(home, ".zhiliu-desktop", ".zcode", "cli"),
    );
    expect(paths.getAppConfigDir()).toBe(join(home, ".zhiliu-desktop", ".zcode", "v2"));
    expect(bootstrap.resolveBootstrapSettingsFile(home)).toBe(
      join(paths.getAppConfigDir(), "setting.json"),
    );
    expect(bootstrap.applyEarlyDataBaseDirBootstrap()).toBeNull();
    expect(existsSync(paths.getAppConfigDir())).toBe(false);

    const { createSettingService } = await import("../../services/src/setting/settingService.js");
    const service = createSettingService();
    await service.update({ locale: "zh-CN" });
    expect((await service.get()).locale).toBe("zh-CN");
    expect(JSON.parse(readFileSync(oldSettings, "utf8")).locale).toBe("en-US");
    expect(existsSync(join(paths.getAppConfigDir(), "setting.json"))).toBe(true);
  });

  it("reads only the brand bootstrap setting and preserves explicit roots", async () => {
    const home = process.env.HOME!;
    const paths = await import("../../services/src/paths.js");
    pathOwner.current = paths;
    const bootstrap = await import("../src/main/desktopDataBaseDirBootstrap.js");
    const brandCustom = join(home, "brand-custom");
    writeJson(bootstrap.resolveBootstrapSettingsFile(home), { dataBaseDir: brandCustom });
    expect(bootstrap.applyEarlyDataBaseDirBootstrap()).toBe(brandCustom);
    expect(paths.getDataBaseDir()).toBe(brandCustom);
    paths.setDataBaseDir(join(home, "explicit-setter"));
    expect(bootstrap.applyEarlyDataBaseDirBootstrap()).toBe(join(home, "explicit-setter"));
    expect(paths.getDataBaseDir()).toBe(join(home, "explicit-setter"));
  });

  it("keeps the environment override ahead of bootstrap, and the setter ahead of environment", async () => {
    const home = process.env.HOME!;
    const explicit = join(home, "explicit-environment");
    vi.stubEnv("ZCODE_DATA_BASE_DIR", explicit);
    const paths = await import("../../services/src/paths.js");
    pathOwner.current = paths;
    const bootstrap = await import("../src/main/desktopDataBaseDirBootstrap.js");
    writeJson(bootstrap.resolveBootstrapSettingsFile(home), { dataBaseDir: join(home, "stale") });
    expect(bootstrap.applyEarlyDataBaseDirBootstrap()).toBe(explicit);
    expect(paths.getDataBaseDir()).toBe(explicit);
    paths.setDataBaseDir(join(home, "setter"));
    expect(paths.getDataBaseDir()).toBe(join(home, "setter"));
    paths.setDataBaseDir(null);
    expect(paths.getDataBaseDir()).toBe(explicit);
  });

  it("retains upstream paths and bootstrap behavior when the fork flag is disabled", async () => {
    brand.enabled = false;
    const home = process.env.HOME!;
    const paths = await import("../../services/src/paths.js");
    pathOwner.current = paths;
    const bootstrap = await import("../src/main/desktopDataBaseDirBootstrap.js");
    expect(paths.getDataBaseDir()).toBe(home);
    expect(paths.getAppConfigDir()).toBe(join(home, ".zcode", "v2"));
    const custom = join(home, "upstream-custom");
    writeJson(bootstrap.resolveBootstrapSettingsFile(home), { dataBaseDir: custom });
    expect(bootstrap.applyEarlyDataBaseDirBootstrap()).toBe(custom);
    expect(paths.getDataBaseDir()).toBe(custom);
  });

  it("clearing a custom data root copies data into the brand default without touching ZCode", async () => {
    const home = process.env.HOME!;
    const paths = await import("../../services/src/paths.js");
    const custom = join(home, "custom-data");
    writeJson(join(custom, ".zcode", "v2", "sessions", "task.json"), { task: "brand-task" });
    writeJson(join(home, ".zcode", "v2", "sessions", "task.json"), { task: "old-task" });
    paths.setDataBaseDir(custom);
    const { createSettingService } = await import("../../services/src/setting/settingService.js");
    await createSettingService().updateDataBaseDir(undefined);
    const target = join(home, ".zhiliu-desktop", ".zcode", "v2");
    expect(JSON.parse(readFileSync(join(target, "sessions", "task.json"), "utf8"))).toEqual({
      task: "brand-task",
    });
    expect(
      JSON.parse(readFileSync(join(home, ".zcode", "v2", "sessions", "task.json"), "utf8")),
    ).toEqual({ task: "old-task" });
    expect(existsSync(join(target, "setting.json"))).toBe(true);
  });
});
