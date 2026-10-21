import type { PluginCandidateRequest } from "./contract.js";
export const approvedOnlyRequest: PluginCandidateRequest = {
  config: {
    enabled: true,
    dirs: [],
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  },
  officialPluginRoots: [],
  storageRoot: "/runtime/plugins",
  explicitPluginRootsOnly: true,
};
