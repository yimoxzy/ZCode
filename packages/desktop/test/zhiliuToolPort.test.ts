import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ZhiliuToolConnectionOptions } from "../src/host/zhiliuToolConnection.js";
import { attachZhiliuToolPort } from "../src/host/zhiliuToolPort.js";

const harness = vi.hoisted(() => ({
  constructorFails: false,
  startHook: undefined as (() => Promise<void>) | undefined,
  stopHook: undefined as (() => Promise<void>) | undefined,
  instances: [] as Array<{
    options: ZhiliuToolConnectionOptions;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("../src/host/zhiliuToolConnection.js", () => ({
  ZhiliuToolConnection: class {
    start = vi.fn(() => harness.startHook?.() ?? Promise.resolve());
    stop = vi.fn(() => harness.stopHook?.() ?? Promise.resolve());
    constructor(readonly options: ZhiliuToolConnectionOptions) {
      if (harness.constructorFails) throw new Error("invalid private key");
      harness.instances.push(this);
    }
  },
}));

class Port extends EventEmitter {
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn(() => {
    this.emit("close");
  });
  message(data: unknown) {
    this.emit("message", { data });
  }
}
const startCommand = () => ({
  type: "start",
  origin: "https://platform.example.test",
  privateKey: "host-private-key-test-only",
  credential: {
    host_token: "host-token-for-test-only-123456",
    device_id: randomUUID(),
    user_id: randomUUID(),
    space_id: randomUUID(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
  },
  stateDirectory: "C:/test-state",
  workspacePath: "C:/selected-workspace",
});
const attachments: Array<ReturnType<typeof attachZhiliuToolPort>> = [];
function attach() {
  const port = new Port(),
    attachment = attachZhiliuToolPort(port);
  attachments.push(attachment);
  return { port, attachment };
}

beforeEach(() => {
  harness.constructorFails = false;
  harness.startHook = undefined;
  harness.stopHook = undefined;
  harness.instances = [];
});
afterEach(async () => {
  for (const attachment of attachments.splice(0)) await attachment.dispose().catch(() => {});
});

describe("织流工具端口的单一生命周期", () => {
  it("starts once and ignores all queued messages after stop", async () => {
    const { port, attachment } = attach();
    expect(port.start).toHaveBeenCalledOnce();
    port.message({ type: "stop" });
    port.message(startCommand());
    port.message({ type: "answer", id: randomUUID(), answer: "approve" });
    await attachment.dispose();
    expect(harness.instances).toHaveLength(0);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("returns the same pending stop promise to every disposal caller", async () => {
    let finish!: () => void;
    harness.stopHook = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const { port, attachment } = attach();
    port.message(startCommand());
    const first = attachment.dispose(),
      second = attachment.dispose();
    expect(first).toBe(second);
    expect(harness.instances[0]!.stop).toHaveBeenCalledOnce();
    let complete = false;
    void second.then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(port.close).not.toHaveBeenCalled();
    port.message(startCommand());
    expect(harness.instances).toHaveLength(1);
    finish();
    await first;
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("rejects pending and late approvals and publishes no events after closure", async () => {
    const { port, attachment } = attach();
    port.message(startCommand());
    const connection = harness.instances[0]!;
    const pending = connection.options.review("operation", "write", "content");
    const reviewId = port.postMessage.mock.calls.at(-1)![0].id;
    port.message({ type: "answer", id: randomUUID(), answer: "approve" });
    await attachment.dispose();
    await expect(pending).resolves.toBe("reject");
    port.message({ type: "answer", id: reviewId, answer: "approve" });
    const count = port.postMessage.mock.calls.length;
    await expect(connection.options.review("operation", "late", "late")).resolves.toBe("reject");
    connection.options.status(true, "late heartbeat");
    expect(port.postMessage).toHaveBeenCalledTimes(count);
  });

  it("resolves only the exact pending review once", async () => {
    const { port } = attach();
    port.message(startCommand());
    const pending = harness.instances[0]!.options.review("operation", "write", "content");
    const reviewId = port.postMessage.mock.calls.at(-1)![0].id;
    port.message({ type: "answer", id: reviewId, answer: "approve" });
    port.message({ type: "answer", id: reviewId, answer: "reject" });
    await expect(pending).resolves.toBe("approve");
  });

  it.each(["invalid", "duplicate-start", "port-close"])(
    "disposes safely for %s",
    async (reason) => {
      const { port, attachment } = attach();
      port.message(startCommand());
      if (reason === "invalid") port.message({ type: "run-arbitrary-command" });
      if (reason === "duplicate-start") port.message(startCommand());
      if (reason === "port-close") port.emit("close");
      await attachment.dispose();
      expect(harness.instances).toHaveLength(1);
      expect(harness.instances[0]!.stop).toHaveBeenCalledOnce();
      expect(port.close).toHaveBeenCalledOnce();
    },
  );

  it("isolates a malformed device key instead of throwing into the Host event loop", async () => {
    harness.constructorFails = true;
    const { port, attachment } = attach();
    expect(() => port.message(startCommand())).not.toThrow();
    await attachment.dispose();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "status",
      connected: false,
      message: expect.stringContaining("凭据无效"),
    });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("always closes the port if connection shutdown rejects while preserving the shared error", async () => {
    harness.stopHook = async () => {
      throw new Error("stop failed");
    };
    const { port, attachment } = attach();
    port.message(startCommand());
    const first = attachment.dispose(),
      second = attachment.dispose();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow("stop failed");
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("contains asynchronous start failures and closes the tool connection", async () => {
    harness.startHook = async () => {
      throw new Error("network unavailable");
    };
    const { port, attachment } = attach();
    port.message(startCommand());
    await Promise.resolve();
    await attachment.dispose();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "status",
      connected: false,
      message: expect.stringContaining("连接失败"),
    });
    expect(port.close).toHaveBeenCalledOnce();
  });
});
