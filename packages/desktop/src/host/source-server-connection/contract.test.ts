import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSourceServerConnectionPort } from "./contract.js";
import { exampleConnectSourceServer } from "./contract.example.js";

const brand = vi.hoisted(() => ({ enabled: true }));
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return brand.enabled;
  },
}));

import { SourceServerConnectionManager } from "../sourceServerConnectionManager.js";

beforeEach(() => {
  brand.enabled = true;
});

const target = { kind: "docker", container: "contract-device" } as const;
const profile = {
  profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
  transport: "docker",
  target,
  createdAt: 1,
  lifecycleState: "active",
} as const;

function fixture() {
  const ports = {
    admitConnection: vi.fn(),
    createAdapter: vi.fn(),
    connectServer: vi.fn(),
    resolveRelease: vi.fn(),
    directory: { recordHandshake: vi.fn() },
  };
  const connection: HostSourceServerConnectionPort = new SourceServerConnectionManager(ports);
  return { connection, ports };
}

describe("Host Source Server connection contract", () => {
  it("织流端口在 admission、凭据、部署和恢复前拒绝，不产生另一份连接状态", async () => {
    const { connection, ports } = fixture();
    try {
      await expect(
        exampleConnectSourceServer(connection, { profile, target, allowInstall: true }),
      ).rejects.toMatchObject({ code: "zhiliu_desktop_inference_unavailable" });
      await expect(connection.updateServer({ profile, target, force: true })).rejects.toMatchObject(
        {
          code: "zhiliu_desktop_inference_unavailable",
        },
      );
      expect(await connection.reconnectOnStartup([{ profile, target }])).toEqual([]);
      expect(connection.listStates()).toEqual([]);
      for (const operation of [
        ports.admitConnection,
        ports.createAdapter,
        ports.connectServer,
        ports.resolveRelease,
        ports.directory.recordHandshake,
      ]) {
        expect(operation).not.toHaveBeenCalled();
      }
    } finally {
      connection.dispose();
    }
  });

  it("上游构建仍由原 owner 执行成员准入，失败不触发传输或握手", async () => {
    brand.enabled = false;
    const { connection, ports } = fixture();
    const denied = new Error("membership rejected");
    ports.admitConnection.mockRejectedValue(denied);
    try {
      await expect(exampleConnectSourceServer(connection, { profile, target })).rejects.toBe(
        denied,
      );
      expect(ports.admitConnection).toHaveBeenCalledWith({
        profile,
        intent: "add",
        confirmIdentityChange: false,
      });
      expect(ports.createAdapter).not.toHaveBeenCalled();
      expect(ports.connectServer).not.toHaveBeenCalled();
      expect(ports.directory.recordHandshake).not.toHaveBeenCalled();
      expect(connection.getStateByProfile(profile.profileId)).toMatchObject({
        state: "failed",
        retryable: false,
      });
    } finally {
      connection.dispose();
    }
  });
});
