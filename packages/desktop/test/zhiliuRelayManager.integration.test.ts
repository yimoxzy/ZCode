import { EventEmitter, once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildZCodeEndpointUrls,
  encodeWebRemoteControlRpcTransportMessage,
  type AppSettings,
} from "@zcode/shared";
import { createZhiliuRelay, type RelayPrincipal } from "../../zhiliu-relay/src/index.js";
import { exampleRelayPrincipal } from "../../zhiliu-relay/src/contract.example.js";
import { createWebRemoteControlManager } from "../src/main/webRemoteControlManager.js";
import { createWebRemoteControlDeviceStorage } from "../src/main/web-remote-relay/index.js";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

it("真实自有Relay连接原Main manager，native设备注册、V4双向Host附件及登出撤销兼容", async () => {
  const deviceGrant = "rc_test_manager_device_01234567890123456789";
  const terminalGrant = "rc_test_manager_terminal_01234567890123456789";
  const principal = exampleRelayPrincipal;
  const grants = new Map<string, RelayPrincipal>([
    [deviceGrant, principal],
    [terminalGrant, { ...principal, role: "terminal", device_mid: null, desktop_device_id: null }],
  ]);
  const relay = await createZhiliuRelay({
    publicOrigin: "https://platform.example",
    introspect: async (grant) => {
      const value = grants.get(grant);
      if (!value) throw new Error("revoked");
      return value;
    },
  });
  cleanups.push(relay.close);
  const events = new EventEmitter();
  const hostPort = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };
  const settings: AppSettings = { recentProjects: [] };
  let authenticated = true;
  const attachWorkspaceHost = vi.fn(async () => ({
    entryId: "shared-host",
    attachmentId: "remote-attachment",
    process: {} as never,
    port: hostPort as never,
  }));
  const releaseWorkspaceHostAttachment = vi.fn();
  const manager = createWebRemoteControlManager({
    relayWsUrl: relay.wsUrl,
    mobileRemoteControlUrl: `${relay.httpUrl}/remote/v4`,
    getEndpointUrls: () => ({
      ...buildZCodeEndpointUrls(relay.httpUrl, { appVersion: "3.16.2" }),
      relayWsUrl: relay.wsUrl,
    }),
    getLogin: async () =>
      authenticated
        ? { userId: principal.principal_id, jwt: deviceGrant, deviceMid: principal.device_mid! }
        : undefined,
    deviceMid: "legacy-machine-mid-must-not-be-used",
    deviceName: "织流本地测试",
    appVersion: "3.16.2",
    deviceStorage: createWebRemoteControlDeviceStorage({
      loadSettings: async () => settings,
      patchSettings: async (patch) => {
        Object.assign(settings, patch);
      },
      deleteLegacyCredential: async () => {},
    }),
    startupRestoreStorageProvider: {
      load: async () => undefined,
      save: async () => {},
      clear: async () => {},
    },
    featureGate: createWebRemoteControlFeatureGate(true),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platformHandlers: {
      isDockerAvailable: async () => false,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    },
    reconnectWorkspace: async () => {},
    attachWorkspaceHost,
    releaseWorkspaceHostAttachment,
    disposeWorkspaceHostAttachmentsForWindow: vi.fn(),
    disposeWorkspaceHostAttachmentsForRemoteSession: vi.fn(),
  });
  cleanups.push(() => manager.suspend(1, "test-cleanup"));
  const started = await manager.start(1, { workspacePath: "/workspace/demo" });
  expect(settings.webRemoteControlRelayV2Device).toMatchObject({
    deviceMid: principal.device_mid,
    userId: principal.principal_id,
  });
  const headers = { Authorization: `Bearer ${terminalGrant}`, "Content-Type": "application/json" };
  const devices = (await (
    await fetch(`${relay.httpUrl}/api/v1/remote/device`, { headers })
  ).json()) as { data: Array<{ device_sid: string; device_mid: string; online: boolean }> };
  expect(devices.data).toEqual([
    expect.objectContaining({
      device_sid: started.sessionId,
      device_mid: principal.device_mid,
      online: true,
    }),
  ]);
  manager.syncAvailableWorkspaces(1, [
    { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
  ]);
  const ticket = (await (
    await fetch(`${relay.httpUrl}/api/v1/remote/token`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "terminal" }),
    })
  ).json()) as { data: { token: string } };
  const socket = new WebSocket(`${relay.wsUrl}?token=${ticket.data.token}`);
  cleanups.push(() => socket.terminate());
  const messages: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "auth_init", device_sid: started.sessionId }));
  await vi.waitFor(() => expect(messages.some((item) => item.type === "auth_ack")).toBe(true));
  const send = (payload: unknown) => socket.send(JSON.stringify({ type: "data", payload }));
  send({ zcode_type: "bootstrap-request", requestId: "real-relay-bootstrap" });
  await vi.waitFor(() =>
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "data",
        payload: expect.objectContaining({
          zcode_type: "bootstrap-response",
          requestId: "real-relay-bootstrap",
        }),
      }),
    ),
  );
  send({
    zcode_type: "workspace-bridge-open",
    requestId: "open-original-host",
    bridgeSessionId: "bridge-main",
    workspaceKey: "/workspace/demo",
    taskId: "existing-local-task",
  });
  await vi.waitFor(() =>
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "data",
        payload: expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-main",
        }),
      }),
    ),
  );
  expect(attachWorkspaceHost).toHaveBeenCalledOnce();
  expect(attachWorkspaceHost).toHaveBeenCalledWith(
    1,
    expect.objectContaining({
      workspacePath: "/workspace/demo",
      initialTaskId: "existing-local-task",
    }),
  );
  const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([7, 8, 9]), {
    bridgeSessionId: "bridge-main",
    firstPhysicalSeq: 1,
    messageSeq: 1,
  });
  send(frame);
  send(frame);
  await vi.waitFor(() => expect(hostPort.postMessage).toHaveBeenCalledOnce());
  expect(hostPort.postMessage.mock.calls[0]![0]).toEqual(new Uint8Array([7, 8, 9]));
  events.emit("message", { data: new Uint8Array([10, 11]) });
  await vi.waitFor(() =>
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "data",
        payload: expect.objectContaining({
          zcode_type: "rpc-frame",
          bridgeSessionId: "bridge-main",
        }),
      }),
    ),
  );
  authenticated = false;
  await manager.notifyAuthStateChanged(1, { state: "signed-out" });
  await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
  expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("remote-attachment");
  expect(manager.getStatus(1)).toMatchObject({ status: "auth-required" });
});
