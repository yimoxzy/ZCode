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
vi.mock("../src/host/storagePreparationProcesses.js", () => ({
  prepareHostStorage: fixture.prepareHost,
  prepareSessionStorage: fixture.prepareSession,
}));

import { createHostDatabaseStartup } from "../src/host/hostDatabaseStartup.js";

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
  const actual = await vi.importActual<typeof import("../src/host/storagePreparationProcesses.js")>(
    "../src/host/storagePreparationProcesses.js",
  );
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
