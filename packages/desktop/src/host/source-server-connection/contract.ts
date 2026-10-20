import type { SourceServerConnectionManager } from "../sourceServerConnectionManager.js";

export type {
  ConnectSourceServerOptions,
  ManagedSourceServerConnection,
  SourceServerConnectionInvalidatedEvent,
  SourceServerConnectionManagerOptions,
  StartupReconnectResult,
} from "../sourceServerConnectionManager.js";

/**
 * Host 内的连接生命周期端口；类型复用原状态机，不建立第二套状态或命令接口。
 * connect/updateServer 等待握手及成员提交；事件和查询只投影本 owner 已接受的事实。
 * disconnect/removeProfile/dispose 使旧代际失效，迟到结果不能复活连接。
 * 织流构建的 connect/updateServer 在 IO 前拒绝，启动恢复返回空；上游构建保留原语义。
 */
export type HostSourceServerConnectionPort = Pick<
  SourceServerConnectionManager,
  | "connect"
  | "updateServer"
  | "reconnectOnStartup"
  | "getStateByProfile"
  | "listStates"
  | "getOnlineConnection"
  | "getFileTransfer"
  | "getRecentOperationLogs"
  | "disconnect"
  | "removeProfile"
  | "dispose"
  | "onDidChangeState"
  | "onDidReconnect"
  | "onDidInvalidateConnection"
  | "onDidAppendOperationLog"
>;
