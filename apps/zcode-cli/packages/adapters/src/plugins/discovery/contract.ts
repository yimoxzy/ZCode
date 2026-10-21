import type { PluginDiscoverRequest, PluginDiagnostic } from "@zcode/contracts";
import type { PluginAbortOptions, PluginCandidate } from "../types.js";

export type PluginCandidateRequest = Pick<
  PluginDiscoverRequest,
  "config" | "officialPluginRoots" | "storageRoot" | "explicitPluginRootsOnly"
>;

/** 只读发现路径；相同文件/输入幂等，无实例创建、执行、写盘或事件。取消沿用原 throwIfAborted。 */
export type ResolvePluginCandidates = (
  request: PluginCandidateRequest,
  diagnostics: PluginDiagnostic[],
  options?: PluginAbortOptions,
) => PluginCandidate[];
