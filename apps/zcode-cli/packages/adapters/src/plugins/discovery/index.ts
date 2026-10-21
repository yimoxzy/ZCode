import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ZCODE_INLINE_PLUGIN_MARKETPLACE,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  type PluginDiagnostic,
} from "@zcode/contracts";
import { isNotFoundError, throwIfAborted } from "../helpers.js";
import { listInstalledPluginRecords, resolveInstalledPluginRoot } from "../marketplace.js";
import { loadBundledOfficialPluginRootsSync } from "../official-marketplace.js";
import type { PluginAbortOptions, PluginCandidate } from "../types.js";
import type { ResolvePluginCandidates } from "./contract.js";
export type * from "./contract.js";

export const resolveNodePluginCandidates: ResolvePluginCandidates = (
  request,
  diagnostics,
  options,
) => {
  const candidates: PluginCandidate[] = [];
  for (const rootPath of request.config.dirs)
    candidates.push({
      defaultEnabled: true,
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath: resolve(rootPath),
      source: "inline",
    });
  if (request.explicitPluginRootsOnly) return candidates;
  for (const rootPath of request.officialPluginRoots ?? [])
    candidates.push({
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath: resolve(rootPath),
      source: "official",
    });
  candidates.push(
    ...scanOfficialCache(request.storageRoot, diagnostics, options).map((rootPath) => ({
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
      source: "official" as const,
    })),
  );
  for (const installed of listInstalledPluginRecords(request.storageRoot))
    candidates.push({
      defaultEnabled: false,
      marketplace: installed.marketplace,
      rootPath: resolveInstalledPluginRoot(request.storageRoot, installed),
      source: "cache",
    });
  return candidates;
};

function scanOfficialCache(
  storageRoot: string,
  diagnostics: PluginDiagnostic[],
  options?: PluginAbortOptions,
): string[] {
  // 官方升级保留旧缓存；bundled 分片是随应用发布版本的权威清单，不能简单选最高 semver。
  const bundledRoots = loadBundledOfficialPluginRootsSync(storageRoot);
  if (bundledRoots !== undefined) {
    for (const _rootPath of bundledRoots) throwIfAborted(options);
    return bundledRoots;
  }
  const cacheRoot = join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  try {
    const roots: string[] = [];
    for (const pluginEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
      throwIfAborted(options);
      if (!pluginEntry.isDirectory()) continue;
      const pluginDir = join(cacheRoot, pluginEntry.name);
      for (const versionEntry of readdirSync(pluginDir, { withFileTypes: true })) {
        if (versionEntry.isDirectory()) roots.push(join(pluginDir, versionEntry.name));
      }
    }
    return roots;
  } catch (error) {
    if (isNotFoundError(error)) return [];
    diagnostics.push({
      code: "plugin_root_not_found",
      message: error instanceof Error ? error.message : `Failed to scan ${cacheRoot}`,
      path: cacheRoot,
      severity: "warning",
    });
    return [];
  }
}
