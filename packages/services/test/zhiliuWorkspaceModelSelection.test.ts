import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachManagedRuntimeMainBridge,
  createManagedRuntimeAuthority,
  createManagedWorkspaceModelSelectionService,
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
      if (closed) return;
      closed = true;
      for (const listeners of closes) for (const listener of listeners) listener();
    },
  })) as [RuntimePrivatePort, RuntimePrivatePort];
}
const identity = (key: string) => `local:${createHash("sha256").update(key).digest("hex")}`;
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});
function setup() {
  const efforts = new Map<string, string | null>([
    [identity("one"), "low"],
    [identity("two"), "high"],
  ]);
  const [hostPort, mainPort] = portPair();
  const authorize = vi.fn(async (key: string) => ({
    origin: "https://platform.example",
    grant: {
      ...exampleRuntimeGrant,
      grant_id: randomUUID(),
      profile: { ...exampleRuntimeGrant.profile, reasoning_effort: efforts.get(key) ?? null },
    },
  }));
  const authority = createManagedRuntimeAuthority({ stopAgents: async () => {} });
  const bridge = attachManagedRuntimeMainBridge(mainPort, { authorize, revoke: async () => {} });
  authority.attach(hostPort);
  const service = createManagedWorkspaceModelSelectionService(authority);
  disposals.push(async () => {
    service.dispose();
    await authority.dispose();
    bridge.dispose();
  });
  const one = { workspacePath: "C:/shared-path", workspaceIdentity: "one" };
  const two = { ...one, workspaceIdentity: "two" };
  return { one, two, authority, bridge, service, authorize, efforts };
}
function assertEffort(
  view: Awaited<ReturnType<ReturnType<typeof setup>["service"]["getView"]>>,
  effort: string,
) {
  expect(view.preferredSelection).toEqual({
    providerId: "zhiliu-managed",
    modelId: "zhiliu-managed",
    options: { reasoningLevel: effort },
  });
  expect(view.providers).toHaveLength(1);
  expect(view.providers[0]!.models[0]!.config.optionSpecs?.reasoningLevel?.values).toEqual([
    effort,
  ]);
  expect(JSON.stringify(view)).not.toContain(exampleRuntimeGrant.runtime_grant);
}

describe("托管模型目录按既有工作区授权派生", () => {
  it("同 Host 同路径不同 identity 并发解析低高档，返回首个项目仍只含低档", async () => {
    const { one, two, service, authority, authorize } = setup();
    const [low, high] = await Promise.all([
      service.getView({ selection: null, workspace: one }),
      service.getView({ selection: null, workspace: two }),
    ]);
    assertEffort(low, "low");
    assertEffort(high, "high");
    const brokerOne = authority.readProfile(one);
    assertEffort(await service.getView({ selection: null, workspace: one }), "low");
    expect(authority.readProfile(one)).toBe(brokerOne);
    expect(authority.readProfile()).toBeUndefined();
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("不指定工作区只返回空目录，不创建授权；默认档只提供 managed", async () => {
    const { service, authorize, one, efforts } = setup();
    expect((await service.getView()).providers).toEqual([]);
    expect((await service.getView({ selection: null })).providers).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
    efforts.set(identity("one"), null);
    assertEffort(await service.getView({ selection: null, workspace: one }), "managed");
  });
  it("低档目录拒绝客户端高档意图，不把其他工作区的档位合并为可选项", async () => {
    const { service, one, two } = setup();
    await service.getView({ selection: null, workspace: two });
    const view = await service.getView({
      workspace: one,
      selection: {
        providerId: "zhiliu-managed",
        modelId: "zhiliu-managed",
        options: { reasoningLevel: "high" },
      },
    });
    assertEffort(view, "low");
    expect(view.selectionIssue).toBeDefined();
    expect(view.effectiveSelection?.options?.reasoningLevel).toBeUndefined();
  });
  it("单项目失效只删除该授权与派生目录，其他项目可继续使用；重登按新授权读", async () => {
    const { one, two, service, authority, bridge, authorize, efforts } = setup();
    await Promise.all([
      service.getView({ selection: null, workspace: one }),
      service.getView({ selection: null, workspace: two }),
    ]);
    const second = authority.readProfile(two);
    const changed = vi.fn();
    const subscription = service.onDidChange(changed);
    await bridge.invalidate(identity("one"));
    expect(authority.readProfile(one)).toBeUndefined();
    expect(authority.readProfile(two)).toBe(second);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ providers: [] }));
    assertEffort(await service.getView({ selection: null, workspace: two }), "high");
    efforts.set(identity("one"), "medium");
    assertEffort(await service.getView({ selection: null, workspace: one }), "medium");
    expect(authorize).toHaveBeenCalledTimes(3);
    subscription.dispose();
  });
  it("失效后旧异步读取不能用前次 profile 恢复目录，新授权读取不受影响", async () => {
    const { one, service, authority, bridge, efforts } = setup();
    const previous = await authority.resolve(one);
    let finish!: (value: typeof previous) => void;
    vi.spyOn(authority, "resolve").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const late = service.getView({ selection: null, workspace: one });
    const rejected = expect(late).rejects.toThrow("授权已失效");
    await bridge.invalidate();
    efforts.set(identity("one"), "high");
    assertEffort(await service.getView({ selection: null, workspace: one }), "high");
    finish(previous);
    await rejected;
    assertEffort(await service.getView({ selection: null, workspace: one }), "high");
  });
  it("dispose 收口迟到读取与后续调用，输入拒绝额外凭据", async () => {
    const { service, one, authority } = setup();
    await expect(
      service.getView({ selection: null, workspace: one, apiKey: "forbidden" } as never),
    ).rejects.toThrow();
    const previous = await authority.resolve(one);
    let finish!: (value: typeof previous) => void;
    vi.spyOn(authority, "resolve").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const late = service.getView({ selection: null, workspace: one });
    const rejected = expect(late).rejects.toThrow("授权已失效");
    service.dispose();
    finish(previous);
    await rejected;
    await expect(service.getView({ selection: null, workspace: one })).rejects.toThrow("dispose");
  });
});
