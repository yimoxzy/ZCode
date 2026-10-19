import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageRootSpec } from "@zcode/shared";

const state = vi.hoisted(() => ({
  enabled: true,
  home: "",
  resolver: null as { resolveRoots: () => Promise<StorageRootSpec[]> } | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  reveal: vi.fn(),
}));
vi.mock("@zcode/shared", async (original) => ({
  ...(await original<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return state.enabled;
  },
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => state.home,
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: (key: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(key, handler),
  },
  shell: { showItemInFolder: state.reveal },
}));
vi.mock("../src/main/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../src/main/storageScanWorkerClient.js", () => ({
  createStorageScanWorkerRunner: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  state.enabled = true;
  state.home = mkdtempSync(join(tmpdir(), "zhiliu-storage-isolation-"));
  state.handlers.clear();
  state.reveal.mockReset();
  vi.stubEnv("HOME", state.home);
  vi.stubEnv("ZCODE_DATA_BASE_DIR", "");
  vi.doMock("@zcode/services/node", async () => {
    const paths = await import("../../services/src/paths.js");
    const storage = await import("../../services/src/storage/adapters/rootsResolver.js");
    return {
      ...paths,
      createStorageRootsResolver: (
        params: Parameters<typeof storage.createStorageRootsResolver>[0],
      ) => {
        state.resolver = storage.createStorageRootsResolver(params);
        return state.resolver;
      },
      createStorageService: vi.fn(),
      createFsStorageCleaner: vi.fn(),
    };
  });
});
afterEach(() => {
  vi.doUnmock("@zcode/services/node");
  vi.unstubAllEnvs();
  rmSync(state.home, { recursive: true, force: true });
});

describe("zhiliu resource manager storage isolation", () => {
  it("exposes only brand roots and refuses old ZCode paths", async () => {
    const oldFile = join(state.home, ".zcode", "old-canary.txt");
    mkdirSync(join(state.home, ".zcode"));
    writeFileSync(oldFile, "old-app-data");
    const { registerResourceManagerStorageIpc } =
      await import("../src/main/resourceManagerStorage.js");
    const { PlatformChannels } = await import("@zcode/shared");
    registerResourceManagerStorageIpc();
    expect(await state.resolver!.resolveRoots()).toEqual([
      {
        id: "home",
        path: join(state.home, ".zhiliu-desktop", ".zcode"),
        hasCustomDataBaseDir: false,
      },
    ]);
    const reveal = state.handlers.get(PlatformChannels.StorageRevealPath)!;
    await reveal({}, oldFile);
    expect(state.reveal).not.toHaveBeenCalled();
    const brandFile = join(state.home, ".zhiliu-desktop", ".zcode", "current.txt");
    await reveal({}, brandFile);
    expect(state.reveal).toHaveBeenCalledWith(brandFile);
    expect(readFileSync(oldFile, "utf8")).toBe("old-app-data");
  });

  it("keeps a custom root alongside the brand home without adding the old ZCode root", async () => {
    const custom = join(state.home, "custom-data");
    vi.stubEnv("ZCODE_DATA_BASE_DIR", custom);
    await import("../src/main/resourceManagerStorage.js");
    const roots = await state.resolver!.resolveRoots();
    expect(roots.map((root) => root.path)).toEqual([
      join(state.home, ".zhiliu-desktop", ".zcode"),
      join(custom, ".zcode"),
    ]);
  });

  it("retains the original home root for upstream builds", async () => {
    state.enabled = false;
    await import("../src/main/resourceManagerStorage.js");
    expect(await state.resolver!.resolveRoots()).toEqual([
      {
        id: "home",
        path: join(state.home, ".zcode"),
        hasCustomDataBaseDir: false,
      },
    ]);
  });
});
