import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  prepareHost: vi.fn(),
  prepareSession: vi.fn(),
  mark: vi.fn(),
  resolveCommand: vi.fn(),
  resolveCwd: vi.fn(),
}));
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));
vi.mock("@zcode/services/storage-startup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/services/storage-startup")>()),
  getTasksIndexDatabasePath: () => `${tmpdir()}/zhiliu-host-startup-test.sqlite`,
  markTasksStoragePrepared: fixture.mark,
  resolveDefaultZCodeAgentCommand: fixture.resolveCommand,
  resolveZCodeAgentSpawnCwd: fixture.resolveCwd,
}));
vi.mock("../src/host/database-startup/storagePreparationProcesses.js", () => ({
  prepareHostStorage: fixture.prepareHost,
  prepareSessionStorage: fixture.prepareSession,
}));

import { createHostDatabaseStartup } from "../src/host/database-startup/hostDatabaseStartup.js";
import { SourceServerConnectionManager } from "../src/host/sourceServerConnectionManager.js";
import {
  connectServerRemote,
  connectServerRemoteOverDuplex,
} from "../src/host/serverRemoteConnection.js";

it("starts the cloud-capable Host without invoking CLI config or reporting a prepared session DB", async () => {
  const order: string[] = [];
  const states: import("@zcode/shared").DatabaseStartupState[] = [];
  fixture.prepareHost.mockImplementation(async () => {
    order.push("host-index");
  });
  const startup = createHostDatabaseStartup({
    cwd: tmpdir(),
    workingDirectories: ["must-not-resolve-an-old-project"],
    initializeServices: async () => {
      order.push("services");
    },
    publish: (state) => states.push(state),
    onFailure: (error) => {
      throw error;
    },
  });
  try {
    await startup.coordinator.start();
    expect(order).toEqual(["host-index", "services"]);
    expect(fixture.mark).toHaveBeenCalledOnce();
    expect(fixture.resolveCwd).not.toHaveBeenCalled();
    expect(fixture.prepareSession).not.toHaveBeenCalled();
    expect(states.some((state) => state.phase === "preparing_session_storage")).toBe(false);
    expect(startup.coordinator.snapshot.phase).toBe("ready");
  } finally {
    startup.dispose();
  }
});

it("rejects direct CLI storage preparation before command/env resolution", async () => {
  const actual = await vi.importActual<
    typeof import("../src/host/database-startup/storagePreparationProcesses.js")
  >("../src/host/database-startup/storagePreparationProcesses.js");
  await expect(
    actual.prepareSessionStorage({
      cwd: tmpdir(),
      env: { OPENAI_API_KEY: "must-not-be-read" },
      signal: new AbortController().signal,
      observePath: vi.fn(),
      report: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "zhiliu_desktop_inference_unavailable" });
  expect(fixture.resolveCommand).not.toHaveBeenCalled();
});

it("rejects Source Server connect and update before admission, transport or release work", async () => {
  const recordHandshake = vi.fn();
  const admitConnection = vi.fn();
  const createAdapter = vi.fn();
  const connectServer = vi.fn();
  const resolveRelease = vi.fn();
  const manager = new SourceServerConnectionManager({
    directory: { recordHandshake },
    admitConnection,
    createAdapter,
    connectServer,
    resolveRelease,
  });
  const target = { kind: "docker", container: "must-not-deploy" } as const;
  const profile = {
    profileId: "blocked-profile",
    transport: "docker",
    target,
    createdAt: 1,
  } as const;
  try {
    await expect(manager.connect({ profile, target, allowInstall: true })).rejects.toMatchObject({
      code: "zhiliu_desktop_inference_unavailable",
    });
    await expect(manager.updateServer({ profile, target, force: true })).rejects.toMatchObject({
      code: "zhiliu_desktop_inference_unavailable",
    });
    expect(await manager.reconnectOnStartup([{ profile, target }])).toEqual([]);
    expect(admitConnection).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(resolveRelease).not.toHaveBeenCalled();
    expect(connectServer).not.toHaveBeenCalled();
    expect(recordHandshake).not.toHaveBeenCalled();
    expect(manager.listStates()).toEqual([]);
  } finally {
    manager.dispose();
  }
});

it("rejects direct URL and duplex remote access before credentials, network or membership writes", async () => {
  const readTarget = vi.fn(() => "https://must-not-connect.invalid");
  const fetchImpl = vi.fn();
  const commitMembership = vi.fn();
  await expect(
    connectServerRemote(
      {
        kind: "server",
        get url() {
          return readTarget();
        },
      },
      { fetchImpl, commitMembership },
    ),
  ).rejects.toMatchObject({ code: "zhiliu_desktop_inference_unavailable" });
  const readToken = vi.fn(() => "must-not-read");
  const createConnection = vi.fn();
  await expect(
    connectServerRemoteOverDuplex({
      get ingressToken() {
        return readToken();
      },
      createConnection,
    }),
  ).rejects.toMatchObject({ code: "zhiliu_desktop_inference_unavailable" });
  expect(readTarget).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(commitMembership).not.toHaveBeenCalled();
  expect(readToken).not.toHaveBeenCalled();
  expect(createConnection).not.toHaveBeenCalled();
});
