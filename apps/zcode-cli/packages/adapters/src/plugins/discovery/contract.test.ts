import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type PluginDiagnostic } from "@zcode/contracts";
import type { PluginCandidateRequest, ResolvePluginCandidates } from "./contract.js";
import { approvedOnlyRequest } from "./contract.example.js";
import { resolveNodePluginCandidates } from "./index.js";

const roots: string[] = [];
function fixture(): PluginCandidateRequest {
  const storageRoot = mkdtempSync(join(tmpdir(), "zcode-discovery-contract-"));
  roots.push(storageRoot);
  return {
    ...approvedOnlyRequest,
    config: { ...approvedOnlyRequest.config, dirs: [join(storageRoot, "approved")] },
    storageRoot,
  };
}
function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function candidateContract(name: string, discover: ResolvePluginCandidates): void {
  describe(name, () => {
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("keeps inline, explicit official, cached official, and installed source precedence", () => {
      const request = fixture();
      request.explicitPluginRootsOnly = false;
      request.officialPluginRoots = [join(request.storageRoot, "explicit-official")];
      const cached = join(
        request.storageRoot,
        "cache",
        ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        "cache-plugin",
        "1",
      );
      mkdirSync(cached, { recursive: true });
      const installed = join(request.storageRoot, "cache", "team", "installed", "1");
      json(join(request.storageRoot, "installed_plugins.json"), {
        version: 1,
        plugins: [
          {
            id: "installed@team",
            name: "installed",
            marketplace: "team",
            version: "1",
            installPath: installed,
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            scope: "user",
          },
        ],
      });
      const diagnostics: PluginDiagnostic[] = [];
      expect(discover(request, diagnostics)).toEqual([
        {
          rootPath: resolve(request.config.dirs[0]!),
          defaultEnabled: true,
          marketplace: "inline",
          source: "inline",
        },
        {
          rootPath: resolve(request.officialPluginRoots[0]!),
          defaultEnabled: false,
          marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
          source: "official",
        },
        {
          rootPath: cached,
          defaultEnabled: false,
          marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
          source: "official",
        },
        { rootPath: installed, defaultEnabled: false, marketplace: "team", source: "cache" },
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("approved-only never scans official or installed state", () => {
      const request = fixture();
      request.officialPluginRoots = [join(request.storageRoot, "unapproved")];
      const cache = join(request.storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, "not a directory");
      json(join(request.storageRoot, "installed_plugins.json"), {
        version: 1,
        plugins: [
          {
            id: "unapproved@team",
            name: "unapproved",
            marketplace: "team",
            version: "1",
            scope: "user",
            installedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const diagnostics: PluginDiagnostic[] = [];
      expect(discover(request, diagnostics)).toEqual([
        {
          rootPath: resolve(request.config.dirs[0]!),
          defaultEnabled: true,
          marketplace: "inline",
          source: "inline",
        },
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("uses the bundled current-version pointer, including rollbacks", () => {
      const request = fixture();
      request.explicitPluginRootsOnly = false;
      const cache = join(
        request.storageRoot,
        "cache",
        ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        "bundled",
      );
      mkdirSync(join(cache, "9"), { recursive: true });
      mkdirSync(join(cache, "1"), { recursive: true });
      json(
        join(
          request.storageRoot,
          "marketplaces",
          ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
          "bundled-marketplace.json",
        ),
        {
          version: 1,
          manifest: {
            name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
            plugins: [{ name: "bundled", cachePath: join(cache, "1") }],
          },
        },
      );
      expect(discover(request, []).map((candidate) => candidate.rootPath)).toEqual([
        resolve(request.config.dirs[0]!),
        join(cache, "1"),
      ]);
      const controller = new AbortController();
      controller.abort();
      expect(() => discover(request, [], { signal: controller.signal })).toThrow(
        "Plugin operation cancelled",
      );
    });

    it("ignores a missing cache but diagnoses an unreadable cache", () => {
      const request = fixture();
      request.explicitPluginRootsOnly = false;
      const diagnostics: PluginDiagnostic[] = [];
      discover(request, diagnostics);
      expect(diagnostics).toEqual([]);
      const cache = join(request.storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, "not a directory");
      discover(request, diagnostics);
      expect(diagnostics).toMatchObject([
        { code: "plugin_root_not_found", path: cache, severity: "warning" },
      ]);
    });
  });
}
candidateContract("Node plugin candidate discovery", resolveNodePluginCandidates);
