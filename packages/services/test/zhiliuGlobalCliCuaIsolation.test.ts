import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brand = vi.hoisted(() => ({ enabled: true }));
vi.mock("@zcode/shared", async (original) => ({
  ...(await original<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return brand.enabled;
  },
}));
let home = "";
function writeCuaConfig(base: string) {
  const file = join(base, ".zcode", "cli", "config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ mcp: { servers: { "computer-use": { type: "stdio", command: "node" } } } }),
  );
}
beforeEach(() => {
  vi.resetModules();
  brand.enabled = true;
  home = mkdtempSync(join(tmpdir(), "zhiliu-global-cua-"));
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("zhiliu global CLI configuration isolation", () => {
  it("does not infer CUA permissions from existing ZCode config", async () => {
    writeCuaConfig(home);
    const { hasGlobalCliZCodeCuaServer } = await import("../src/node.js");
    expect(hasGlobalCliZCodeCuaServer({ HOME: home })).toBe(false);
    writeCuaConfig(join(home, ".zhiliu-desktop"));
    expect(hasGlobalCliZCodeCuaServer({ HOME: home })).toBe(true);
  });
  it("preserves upstream global CLI configuration discovery", async () => {
    brand.enabled = false;
    writeCuaConfig(home);
    const { hasGlobalCliZCodeCuaServer } = await import("../src/node.js");
    expect(hasGlobalCliZCodeCuaServer({ HOME: home })).toBe(true);
  });
});
