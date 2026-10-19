import { describe, expect, it, vi } from "vitest";
import { createZhiliuToolsAttachmentOwner } from "../src/host/zhiliuToolsAttachmentOwner.js";
import { runHostShutdownPhases } from "../src/host/hostShutdownPhases.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
const port = () => ({ close: vi.fn() });

describe("织流文件端口唯一所有者", () => {
  it("waits for the old connection and admits only the latest replacement", async () => {
    const stopped = deferred();
    const dispose = vi.fn(() => stopped.promise);
    const attach = vi.fn((_candidate: ReturnType<typeof port>) => ({ dispose }));
    const owner = createZhiliuToolsAttachmentOwner(attach);
    const initial = port(),
      stale = port(),
      latest = port();
    await owner.replace(initial);
    const replacing = owner.replace(stale);
    await Promise.resolve();
    const replacingAgain = owner.replace(latest);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    stopped.resolve();
    await Promise.all([replacing, replacingAgain]);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls.map(([value]) => value)).toEqual([initial, latest]);
  });

  it("shutdown closes pending ports immediately and prevents late attachment", async () => {
    const stopped = deferred();
    const attach = vi.fn(() => ({ dispose: () => stopped.promise }));
    const owner = createZhiliuToolsAttachmentOwner(attach);
    await owner.replace(port());
    const next = port();
    const replacing = owner.replace(next);
    await Promise.resolve();
    const shutdown = owner.dispose();
    expect(owner.dispose()).toBe(shutdown);
    expect(next.close).toHaveBeenCalledTimes(1);
    const late = port();
    await owner.replace(late);
    expect(late.close).toHaveBeenCalledTimes(1);
    stopped.resolve();
    await Promise.all([replacing, shutdown]);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("closes all candidates after a failed stop and stays closed", async () => {
    const attach = vi.fn(() => ({
      dispose: async () => {
        throw new Error("failed");
      },
    }));
    const owner = createZhiliuToolsAttachmentOwner(attach);
    await owner.replace(port());
    const next = port();
    await expect(owner.replace(next)).rejects.toThrow("failed");
    expect(next.close).toHaveBeenCalledTimes(1);
    const late = port();
    await owner.replace(late);
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("a stalled file connection cannot skip other Host shutdown phases", async () => {
    vi.useFakeTimers();
    try {
      const owner = createZhiliuToolsAttachmentOwner(() => ({
        dispose: () => new Promise<void>(() => {}),
      }));
      await owner.replace(port());
      const nextPhase = vi.fn(async () => {});
      const shutdown = runHostShutdownPhases(
        [
          { name: "zhiliu-tools-dispose", run: () => owner.dispose() },
          { name: "services", run: nextPhase },
        ],
        { phaseTimeoutMs: 500, log: vi.fn() },
      );
      await vi.advanceTimersByTimeAsync(500);
      await expect(shutdown).resolves.toMatchObject({
        exitCode: 1,
        timedOutPhases: ["zhiliu-tools-dispose"],
      });
      expect(nextPhase).toHaveBeenCalledTimes(1);
      const late = port();
      await owner.replace(late);
      expect(late.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
