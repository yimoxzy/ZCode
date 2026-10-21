/** Presentation only; Desktop Main/Host own account, selection, and runtime facts. */
export const zhiliuRuntimeSelectModule = {
  id: "zhiliu-runtime-select",
  requires: ["shared", "ui", "zhiliu-runtime-contract"],
  provides: ["zhiliu-runtime-select"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
