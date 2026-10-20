/**
 * host-source-server-connection 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const hostSourceServerConnectionModule = {
  id: "host-source-server-connection",
  requires: ["desktop", "project-storage", "rpc", "server", "services", "shared"],
  provides: ["host-source-server-connection"],
  publicEntrypoints: ["contract.ts", "../sourceServerConnectionManager.ts"],
} as const;
