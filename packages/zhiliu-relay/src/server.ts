import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseWebRemoteControlRelayV2HttpRequest,
  parseWebRemoteControlRelayV2OutgoingMessage,
  WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH,
  type WebRemoteControlRelayV2Device,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2Meta,
  type WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";
import {
  relayPrincipalSchema,
  type RelayPrincipal,
  type RelayOptions,
  type RelayHandle,
} from "./contract.js";

const MAX_FRAME_BYTES = 1_048_576;
const MAX_BUFFER_BYTES = 4 * MAX_FRAME_BYTES;
const RC = /^rc_[A-Za-z0-9_-]{20,512}$/u;
interface Device {
  principal: RelayPrincipal;
  view: WebRemoteControlRelayV2Device;
}
interface Ticket {
  principal: RelayPrincipal;
  grant: string;
  expiresAt: number;
}
interface Connection extends Ticket {
  socket: WebSocket;
  deviceSid?: string;
  terminalSid: string;
  meta: WebRemoteControlRelayV2Meta;
  lastInput: number;
  openedAt: number;
}

/** 内省只向启动时固定的内部地址发出；失败不信任旧授权。 */
export function createRelayIntrospector(input: {
  url: string;
  serviceToken: string;
  http?: typeof fetch;
}) {
  const url = new URL(input.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !input.serviceToken.trim()
  )
    throw new Error("relay introspection configuration invalid");
  return async (relayGrant: string): Promise<RelayPrincipal> => {
    const response = await (input.http ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: {
        Authorization: `Bearer ${input.serviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ relay_grant: relayGrant }),
    });
    if (!response.ok) throw new Error("relay authorization unavailable");
    return relayPrincipalSchema.parse(await response.json());
  };
}

/** 兼容原客户端V2；会话、队列、snapshot仍由Desktop Host独占。 */
export async function createZhiliuRelay(options: RelayOptions): Promise<RelayHandle> {
  const now = options.now ?? Date.now;
  const allowedOrigin = new URL(options.publicOrigin).origin;
  const devices = new Map<string, Device>();
  const tickets = new Map<string, Ticket>();
  const connections = new Set<Connection>();
  const owners = new Map<string, Partial<Record<WebRemoteControlRelayV2Role, Connection>>>();
  const verifying = new Map<string, Promise<RelayPrincipal>>();
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  let closed = false,
    checking = false;
  const authorize = async (grant: string) => {
    if (!RC.test(grant) || closed) throw new Error("relay authorization unavailable");
    let pending = verifying.get(grant);
    if (!pending) {
      pending = options.introspect(grant).then((value) => {
        const principal = relayPrincipalSchema.parse(value);
        if (Date.parse(principal.expires_at) <= now())
          throw new Error("relay authorization expired");
        return principal;
      });
      verifying.set(grant, pending);
      void pending
        .finally(() => {
          if (verifying.get(grant) === pending) verifying.delete(grant);
        })
        .catch(() => {});
    }
    return pending;
  };
  const matches = (principal: RelayPrincipal, device: Device) =>
    principal.principal_id === device.principal.principal_id &&
    (!principal.desktop_device_id ||
      principal.desktop_device_id === device.principal.desktop_device_id);
  const send = (connection: Connection, message: WebRemoteControlRelayV2IncomingMessage) => {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > MAX_BUFFER_BYTES) {
      connection.socket.terminate();
      return;
    }
    connection.socket.send(JSON.stringify({ ...message, server_ts: Math.floor(now() / 1000) }));
  };
  const rejectConnection = (
    connection: Connection,
    code: "AUTH_FAILED" | "WRONG_PARAM" | "KICKED" | "DEVICE_OFFLINE" | "INTERNAL",
  ) => {
    send(connection, { type: "error", code });
    connection.socket.close(1008);
  };
  const peer = (connection: Connection) =>
    owners.get(connection.deviceSid ?? "")?.[
      connection.principal.role === "device" ? "terminal" : "device"
    ];
  const view = (device: Device) => ({
    ...device.view,
    online: !!owners.get(device.view.device_sid)?.device,
    meta: owners.get(device.view.device_sid)?.device?.meta ?? {},
  });
  const readBody = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16384) throw new Error("request too large");
      chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString();
    return text ? JSON.parse(text) : {};
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (
      status: number,
      data?: unknown,
      code = status === 200 ? 0 : status,
      msg = "",
    ) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ code, msg, ...(data === undefined ? {} : { data }) }));
    };
    const url = new URL(request.url ?? "/", "http://relay");
    if (url.pathname === "/healthz") {
      reply(closed ? 503 : 200, { ready: !closed });
      return;
    }
    if ((request.headers.origin && request.headers.origin !== allowedOrigin) || url.search) {
      reply(403);
      return;
    }
    const grant = request.headers.authorization?.match(/^Bearer (rc_[A-Za-z0-9_-]+)$/u)?.[1];
    let principal: RelayPrincipal;
    try {
      principal = await authorize(grant ?? "");
    } catch {
      reply(401);
      return;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      reply(400, undefined, 3001, "parameter error");
      return;
    }
    if (closed) {
      reply(503);
      return;
    }
    if (url.pathname === "/api/v1/remote/token" && request.method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("token", body);
      if (!parsed) {
        reply(400, undefined, 3001, "parameter error");
        return;
      }
      if (parsed.role !== principal.role) {
        reply(403);
        return;
      }
      if (
        [...tickets.values()].filter(
          (ticket) => ticket.principal.principal_id === principal.principal_id,
        ).length >= 128
      ) {
        reply(429);
        return;
      }
      const token = randomBytes(16).toString("base64url");
      const expiresAt = Math.min(now() + 60000, Date.parse(principal.expires_at));
      tickets.set(token, { principal, grant: grant!, expiresAt });
      reply(200, { token, expires_in: Math.max(1, Math.floor((expiresAt - now()) / 1000)) });
      return;
    }
    if (url.pathname === "/api/v1/remote/device" && request.method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("register", body);
      if (!parsed) {
        reply(400, undefined, 3001, "parameter error");
        return;
      }
      if (principal.role !== "device" || parsed.device_mid !== principal.device_mid) {
        reply(403);
        return;
      }
      // 同一物理授权设备最多保留一个离线SID；活动SID不因并发窗口注册被偷换。
      for (const [sid, device] of devices)
        if (matches(principal, device) && !owners.get(sid)?.device) devices.delete(sid);
      if (
        devices.size >= 10000 ||
        [...devices.values()].filter(
          (device) => device.principal.principal_id === principal.principal_id,
        ).length >= 64
      ) {
        reply(429);
        return;
      }
      const device: Device = {
        principal,
        view: {
          device_sid: `d_${randomUUID()}`,
          device_mid: parsed.device_mid,
          online: false,
          created_at: Math.floor(now() / 1000),
          meta: {},
        },
      };
      devices.set(device.view.device_sid, device);
      reply(200, device.view);
      return;
    }
    if (url.pathname === "/api/v1/remote/device" && request.method === "GET") {
      reply(200, [...devices.values()].filter((device) => matches(principal, device)).map(view));
      return;
    }
    if (url.pathname === "/api/v1/remote/device/delete" && request.method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("delete", body);
      if (!parsed) {
        reply(400, undefined, 3001, "parameter error");
        return;
      }
      const device = devices.get(parsed.device_sid);
      if (!device) {
        reply(200);
        return;
      }
      if (!matches(principal, device)) {
        reply(200, undefined, 1006, "no permission");
        return;
      }
      if (owners.get(parsed.device_sid)?.device) {
        reply(400, undefined, 3005, "wrong status");
        return;
      }
      devices.delete(parsed.device_sid);
      reply(200);
      return;
    }
    reply(404);
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://relay");
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const ticketKey = url.searchParams.get("token") ?? "";
    const ticket = tickets.get(ticketKey);
    tickets.delete(ticketKey);
    const deny = () => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    if (
      closed ||
      connections.size >= 1000 ||
      url.pathname !== WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH ||
      (request.headers.origin && request.headers.origin !== allowedOrigin) ||
      !ticket ||
      ticket.expiresAt <= now()
    ) {
      deny();
      return;
    }
    void authorize(ticket.grant)
      .then((principal) => {
        if (
          closed ||
          socket.destroyed ||
          JSON.stringify(principal) !== JSON.stringify(ticket.principal)
        ) {
          deny();
          return;
        }
        wsServer.handleUpgrade(request, socket, head, (ws) => {
          const connection: Connection = {
            ...ticket,
            socket: ws,
            terminalSid: principal.role === "terminal" ? `t_${randomUUID()}` : "",
            meta: {},
            lastInput: now(),
            openedAt: now(),
          };
          connections.add(connection);
          ws.on("error", () => ws.terminate());
          ws.on("message", (raw, isBinary) => {
            if (Date.parse(connection.principal.expires_at) <= now() || closed) {
              rejectConnection(connection, "AUTH_FAILED");
              return;
            }
            let value: unknown;
            try {
              value = JSON.parse(raw.toString());
            } catch {
              rejectConnection(connection, "WRONG_PARAM");
              return;
            }
            const parsed = isBinary ? null : parseWebRemoteControlRelayV2OutgoingMessage(value);
            if (!parsed) {
              rejectConnection(connection, "WRONG_PARAM");
              return;
            }
            connection.lastInput = now();
            if (parsed.type === "auth_init") {
              const device = devices.get(parsed.device_sid);
              if (connection.deviceSid) {
                rejectConnection(connection, "WRONG_PARAM");
                return;
              }
              if (
                !device ||
                !matches(principal, device) ||
                (principal.role === "device" && device.view.device_mid !== principal.device_mid)
              ) {
                rejectConnection(connection, "AUTH_FAILED");
                return;
              }
              if (principal.role === "terminal" && !owners.get(parsed.device_sid)?.device) {
                rejectConnection(connection, "DEVICE_OFFLINE");
                return;
              }
              connection.deviceSid = parsed.device_sid;
              connection.meta = parsed.meta ?? {};
              const roles = owners.get(parsed.device_sid) ?? {};
              const old = roles[principal.role];
              roles[principal.role] = connection;
              owners.set(parsed.device_sid, roles);
              if (old) rejectConnection(old, "KICKED");
              const other = peer(connection),
                pair_status = other ? "matched" : "waiting";
              if (other) send(other, { type: "pair_status_ack", pair_status, terminal_sid: "" });
              send(connection, {
                type: "auth_ack",
                device_sid: parsed.device_sid,
                terminal_sid: connection.terminalSid,
                pair_status,
              });
              return;
            }
            if (!connection.deviceSid) {
              rejectConnection(connection, "AUTH_FAILED");
              return;
            }
            const other = peer(connection);
            if (parsed.type === "pair_status_query") {
              send(connection, {
                type: "pair_status_ack",
                pair_status: other ? "matched" : "waiting",
                terminal_sid: other?.terminalSid ?? "",
              });
              return;
            }
            if (!other) {
              rejectConnection(
                connection,
                principal.role === "terminal" ? "DEVICE_OFFLINE" : "INTERNAL",
              );
              return;
            }
            // payload只透明转发，绝不以里面的user/space字段覆盖双方已鉴权身份。
            if (Date.parse(other.principal.expires_at) <= now()) {
              rejectConnection(other, "AUTH_FAILED");
              return;
            }
            send(other, { type: "data", payload: parsed.payload });
          });
          ws.on("close", () => {
            connections.delete(connection);
            const roles = owners.get(connection.deviceSid ?? "");
            if (roles?.[principal.role] !== connection) return;
            delete roles[principal.role];
            const other = peer(connection);
            if (other) {
              send(other, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
              if (principal.role === "device") rejectConnection(other, "DEVICE_OFFLINE");
            }
            if (!roles.device && !roles.terminal) owners.delete(connection.deviceSid ?? "");
          });
        });
      })
      .catch(deny);
  });
  const timer = setInterval(() => {
    for (const [token, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(token);
    for (const connection of connections) {
      if (
        Date.parse(connection.principal.expires_at) <= now() ||
        now() - connection.lastInput > 15000 ||
        (!connection.deviceSid && now() - connection.openedAt > 5000)
      )
        rejectConnection(connection, "AUTH_FAILED");
    }
    if (checking || closed) return;
    checking = true;
    void Promise.all(
      [...connections].map(async (connection) => {
        try {
          const principal = await authorize(connection.grant);
          if (JSON.stringify(principal) !== JSON.stringify(connection.principal))
            rejectConnection(connection, "AUTH_FAILED");
        } catch {
          rejectConnection(connection, "AUTH_FAILED");
        }
      }),
    ).finally(() => {
      checking = false;
    });
  }, options.revalidateIntervalMs ?? 5000);
  timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    closed = true;
    clearInterval(timer);
    wsServer.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("relay bind failed");
  let closing: Promise<void> | undefined;
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}${WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH}`,
    close() {
      if (closing) return closing;
      closed = true;
      clearInterval(timer);
      tickets.clear();
      for (const connection of connections) connection.socket.terminate();
      closing = new Promise<void>((resolve) => {
        wsServer.close(() => {});
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
