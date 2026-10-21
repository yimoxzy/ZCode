import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createManagedRuntimeAuthority,
  attachManagedRuntimeMainBridge,
  type RuntimePrivatePort,
} from "../src/zhiliu-runtime/index.js";
import { exampleRuntimeGrant } from "../src/zhiliu-runtime/contract.example.js";

function portPair(): [RuntimePrivatePort, RuntimePrivatePort] {
  const messages: Array<Array<(event: { data: unknown }) => void>> = [[], []];
  const closes: Array<Array<() => void>> = [[], []];
  let closed = false;
  return [0, 1].map((index) => ({
    postMessage(data: unknown) {
      if (!closed)
        queueMicrotask(() => {
          if (!closed) for (const listener of messages[1 - index]!) listener({ data });
        });
    },
    on(event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)) {
      if (event === "message")
        messages[index]!.push(listener as (event: { data: unknown }) => void);
      else closes[index]!.push(listener as () => void);
    },
    start() {},
    close() {
      if (!closed) {
        closed = true;
        for (const listeners of closes) for (const listener of listeners) listener();
      }
    },
  })) as [RuntimePrivatePort, RuntimePrivatePort];
}
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});
function setup(onAvailable?: () => void) {
  const [hostPort, mainPort] = portPair();
  const authorize = vi.fn(async (_identity: string) => ({
    origin: "https://platform.example",
    grant: { ...exampleRuntimeGrant, grant_id: randomUUID() },
  }));
  const revoke = vi.fn(async (_id: string) => {});
  const stopAgents = vi.fn(async () => {});
  const authority = createManagedRuntimeAuthority({ stopAgents, onAvailable });
  const bridge = attachManagedRuntimeMainBridge(mainPort, { authorize, revoke });
  authority.attach(hostPort);
  disposals.push(async () => {
    await authority.dispose();
    bridge.dispose();
  });
  return { authority, bridge, authorize, revoke, stopAgents };
}
describe("托管运行时Host/Main生命周期", () => {
  it("工作区切换只回收匹配的broker与CLI，不打断其他工作区", async () => {
    const { authority, bridge, authorize, stopAgents } = setup();
    const one = { workspacePath: "C:/project", workspaceIdentity: "one" },
      two = { ...one, workspaceIdentity: "two" };
    const first = await authority.resolve(one),
      second = await authority.resolve(two);
    await bridge.invalidate(`local:${createHash("sha256").update("one").digest("hex")}`);
    expect(stopAgents).toHaveBeenCalledWith(one);
    expect(stopAgents).toHaveBeenCalledTimes(1);
    expect(await authority.resolve(two)).toBe(second);
    expect(await authority.resolve(one)).not.toBe(first);
    expect(authorize).toHaveBeenCalledTimes(3);
    await expect(fetch(`${first.gatewayBaseUrl}/chat/completions`)).rejects.toThrow();
  });
  it("工作区换代时迟到的grant被撤销，旧promise不能覆盖新broker", async () => {
    const { authority, bridge, authorize, revoke } = setup();
    const target = { workspacePath: "C:/project", workspaceIdentity: "one" };
    let finish!: (value: Awaited<ReturnType<typeof authorize>>) => void;
    authorize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = authority.resolve(target);
    const rejected = expect(old).rejects.toThrow("配置已切换");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await bridge.invalidate(`local:${createHash("sha256").update("one").digest("hex")}`);
    await rejected;
    const current = await authority.resolve(target);
    finish({ origin: "https://platform.example", grant: exampleRuntimeGrant });
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(exampleRuntimeGrant.grant_id));
    expect(await authority.resolve(target)).toBe(current);
  });
  it("首次登录可通知Host重试既有预热，通知本身不能创建授权或broker", async () => {
    const onAvailable = vi.fn();
    const { authority, bridge, authorize } = setup(onAvailable);
    bridge.available();
    await vi.waitFor(() => expect(onAvailable).toHaveBeenCalledOnce());
    expect(authorize).not.toHaveBeenCalled();
    expect(authority.readProfile()).toBeUndefined();
    bridge.dispose();
    bridge.available();
    expect(onAvailable).toHaveBeenCalledOnce();
  });
  it("workspace identity优先且单工作区授权single-flight，不发送路径或登录凭据", async () => {
    const { authority, authorize } = setup();
    const target = { workspacePath: "C:/private-project", workspaceIdentity: "identity-one" };
    const [one, two] = await Promise.all([
      authority.resolve(target),
      authority.resolve({ ...target, workspacePath: "C:/another-path" }),
    ]);
    expect(one).toBe(two);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]![0]).toMatch(/^local:[a-f0-9]{64}$/u);
    expect(JSON.stringify(authorize.mock.calls)).not.toContain("private-project");
    expect(JSON.stringify(one)).not.toContain(exampleRuntimeGrant.runtime_grant);
    const separate = await authority.resolve({ ...target, workspaceIdentity: "identity-two" });
    expect(separate.gatewayBaseUrl).not.toBe(one.gatewayBaseUrl);
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("失效确认等待Agent清理，broker即时关闭，重新登录可创建新授权", async () => {
    const { authority, bridge, authorize, revoke, stopAgents } = setup();
    const target = { workspacePath: "C:/project" };
    const previous = await authority.resolve(target);
    let finish!: () => void;
    stopAgents.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let confirmed = false;
    const cleaning = bridge.invalidate().then(() => {
      confirmed = true;
    });
    await vi.waitFor(() => expect(stopAgents).toHaveBeenCalledTimes(1));
    expect(confirmed).toBe(false);
    expect(authority.readProfile()).toBeUndefined();
    await expect(fetch(`${previous.gatewayBaseUrl}/chat/completions`)).rejects.toThrow();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    finish();
    await cleaning;
    const next = await authority.resolve(target);
    expect(next.capabilityToken).not.toBe(previous.capabilityToken);
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("退出期间迟到grant被撤销，不能恢复旧broker", async () => {
    const { authority, bridge, authorize, revoke } = setup();
    let finish!: (value: Awaited<ReturnType<typeof authorize>>) => void;
    authorize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const resolving = authority.resolve({ workspacePath: "C:/project" });
    const rejected = expect(resolving).rejects.toThrow("织流授权已断开");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    await bridge.invalidate();
    await rejected;
    const late = {
      origin: "https://platform.example",
      grant: { ...exampleRuntimeGrant, grant_id: randomUUID() },
    };
    finish(late);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(late.grant.grant_id));
    expect(authority.readProfile()).toBeUndefined();
    expect((await authority.resolve({ workspacePath: "C:/project" })).modelId).toBe(
      "zhiliu-managed",
    );
  });
  it("Main端口先关闭，迟到授权也只能撤销", async () => {
    const { authority, bridge, authorize, revoke } = setup();
    let finish!: (value: Awaited<ReturnType<typeof authorize>>) => void;
    authorize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const resolving = authority.resolve({ workspacePath: "C:/project" });
    const rejected = expect(resolving).rejects.toThrow("织流授权已断开");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    bridge.dispose();
    await rejected;
    const late = {
      origin: "https://platform.example",
      grant: { ...exampleRuntimeGrant, grant_id: randomUUID() },
    };
    finish(late);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(late.grant.grant_id));
    await expect(authority.resolve({ workspacePath: "C:/project" })).rejects.toThrow("请先登录");
  });
});
