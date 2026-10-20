import type { ConnectSourceServerOptions, HostSourceServerConnectionPort } from "./contract.js";

/** 调用方提交目录 owner 已解析的 Profile；连接 owner 统一裁决执行权限和握手提交。 */
export async function exampleConnectSourceServer(
  connection: HostSourceServerConnectionPort,
  input: ConnectSourceServerOptions,
) {
  return connection.connect(input);
}
