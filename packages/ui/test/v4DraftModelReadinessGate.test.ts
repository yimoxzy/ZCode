// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";

const flags = vi.hoisted(() => ({ managed: false }));
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return flags.managed;
  },
}));

function selectionView(revision: number, withModel: boolean): ModelSelectionView {
  return {
    revision,
    providers: withModel
      ? [
          {
            providerId: "provider-a",
            config: { kind: "api" },
            models: [{ modelId: "model-a", config: {} }],
          },
        ]
      : [],
  };
}

function selectionService(params: {
  getView: () => Promise<ModelSelectionView>;
  emitter?: Emitter<ModelSelectionView>;
}): Pick<IModelSelectionService, "getView" | "onDidChange"> {
  const emitter = params.emitter ?? new Emitter<ModelSelectionView>();
  return {
    getView: params.getView,
    onDidChange: emitter.event,
  };
}

describe("draft model readiness gate", () => {
  beforeEach(() => {
    flags.managed = false;
  });

  it("首发复查跨托管失效时不能用旧账号 ready 放行，也不覆盖新的缺失状态", async () => {
    flags.managed = true;
    const emitter = new Emitter<ModelSelectionView>();
    let resolveSend!: (view: ModelSelectionView) => void;
    const getView = vi
      .fn()
      .mockResolvedValueOnce(selectionView(1, true))
      .mockImplementationOnce(
        () =>
          new Promise<ModelSelectionView>((resolve) => {
            resolveSend = resolve;
          }),
      )
      .mockResolvedValueOnce(selectionView(2, false));
    const service = selectionService({ getView, emitter });
    const hook = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/one",
        sessionId: null,
        modelSelectionService: service,
      }),
    );
    await waitFor(() => expect(hook.result.current.agentStartupAllowed).toBe(true));
    const send = hook.result.current.ensureReadyForSend();
    act(() => emitter.fire(selectionView(2, true)));
    await waitFor(() => expect(hook.result.current.error).not.toBeNull());
    await act(async () => {
      resolveSend(selectionView(1, true));
      await expect(send).resolves.toBe(false);
    });
    expect(hook.result.current.agentStartupAllowed).toBe(false);
    expect(hook.result.current.error).not.toBeNull();
  });

  it("托管失效只触发本项目重读，初读及首发复查都携带同一 target", async () => {
    flags.managed = true;
    const emitter = new Emitter<ModelSelectionView>();
    let resolveRefresh!: (view: ModelSelectionView) => void;
    const getView = vi
      .fn()
      .mockResolvedValueOnce(selectionView(1, true))
      .mockImplementationOnce(
        () =>
          new Promise<ModelSelectionView>((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(selectionView(3, true));
    const service = selectionService({ getView, emitter });
    const hook = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/same",
        workspaceIdentity: "space:one",
        sessionId: null,
        modelSelectionService: service,
      }),
    );
    const input = {
      selection: null,
      workspace: { workspacePath: "/same", workspaceIdentity: "space:one" },
    };
    await waitFor(() => expect(hook.result.current.agentStartupAllowed).toBe(true));
    expect(getView).toHaveBeenLastCalledWith(input);
    act(() => emitter.fire(selectionView(2, false)));
    expect(hook.result.current.agentStartupAllowed).toBe(false);
    expect(hook.result.current.error).toBeNull();
    await act(async () => resolveRefresh(selectionView(2, true)));
    expect(hook.result.current.agentStartupAllowed).toBe(true);
    await act(async () => expect(hook.result.current.ensureReadyForSend()).resolves.toBe(true));
    expect(getView).toHaveBeenLastCalledWith(input);
    expect(getView).toHaveBeenCalledTimes(3);
  });

  it("同 Host 切换 identity 时立即检查新项目，迟到旧 ready 不放行", async () => {
    flags.managed = true;
    const pending: Array<(view: ModelSelectionView) => void> = [];
    const getView = vi.fn(
      () => new Promise<ModelSelectionView>((resolve) => pending.push(resolve)),
    );
    const service = selectionService({ getView });
    const hook = renderHook(
      ({ identity }) =>
        useDraftModelReadinessGate({
          workspacePath: "/same",
          workspaceIdentity: identity,
          sessionId: null,
          modelSelectionService: service,
        }),
      { initialProps: { identity: "space:one" } },
    );
    hook.rerender({ identity: "space:two" });
    await act(async () => pending[0]!(selectionView(9, true)));
    expect(hook.result.current.agentStartupAllowed).toBe(false);
    await act(async () => pending[1]!(selectionView(1, false)));
    expect(hook.result.current.agentStartupAllowed).toBe(false);
    expect(hook.result.current.error).not.toBeNull();
    expect(getView).toHaveBeenLastCalledWith({
      selection: null,
      workspace: {
        workspacePath: "/same",
        workspaceIdentity: "space:two",
      },
    });
  });

  it("托管失效后的迟到旧读取失败不能覆盖新项目 ready", async () => {
    flags.managed = true;
    const emitter = new Emitter<ModelSelectionView>();
    let rejectInitial!: (error: Error) => void;
    const getView = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ModelSelectionView>((_resolve, reject) => {
            rejectInitial = reject;
          }),
      )
      .mockResolvedValueOnce(selectionView(2, true));
    const service = selectionService({ getView, emitter });
    const hook = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/one",
        sessionId: null,
        modelSelectionService: service,
      }),
    );
    act(() => emitter.fire(selectionView(2, false)));
    await waitFor(() => expect(hook.result.current.agentStartupAllowed).toBe(true));
    await act(async () => rejectInitial(new Error("old account failed")));
    expect(hook.result.current.agentStartupAllowed).toBe(true);
    expect(hook.result.current.error).toBeNull();
  });

  it("进入新草稿的每一帧都先检查模型，不继承正式会话的 ready", async () => {
    const pending: Array<(view: ModelSelectionView) => void> = [];
    const service = selectionService({
      getView: () => new Promise((resolve) => pending.push(resolve)),
    });
    const observations: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => {
        const gate = useDraftModelReadinessGate({
          workspacePath: "/workspace/app",
          sessionId,
          modelSelectionService: service,
        });
        if (sessionId === null) observations.push(gate.agentStartupAllowed);
        return gate;
      },
      { initialProps: { sessionId: "active" as string | null } },
    );

    rerender({ sessionId: null });
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((allowed) => !allowed)).toBe(true);
    await act(async () => pending[0]!(selectionView(1, true)));
    expect(result.current.agentStartupAllowed).toBe(true);
    rerender({ sessionId: "active-again" });
    observations.length = 0;
    rerender({ sessionId: null });
    expect(observations.every((allowed) => !allowed)).toBe(true);
    await act(async () => pending[1]!(selectionView(2, true)));
    expect(result.current.agentStartupAllowed).toBe(true);
  });

  it("旧草稿发送复查的迟到结果不覆盖新草稿的 ready", async () => {
    let resolveOld!: (view: ModelSelectionView) => void;
    const getView = vi.fn(async () => selectionView(1, true));
    const service = selectionService({ getView });
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useDraftModelReadinessGate({
          workspacePath: "/workspace/app",
          sessionId,
          modelSelectionService: service,
        }),
      { initialProps: { sessionId: null as string | null } },
    );
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    getView.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const oldSend = result.current.ensureReadyForSend();
    rerender({ sessionId: "active" });
    rerender({ sessionId: null });
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    await act(async () => {
      resolveOld(selectionView(2, false));
      await oldSend;
    });
    expect(result.current.agentStartupAllowed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("blocks a new draft when the Selection View confirms there are no models", async () => {
    const service = selectionService({ getView: vi.fn(async () => selectionView(1, false)) });
    const { result } = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/workspace/app",
        sessionId: null,
        modelSelectionService: service,
      }),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);
  });

  it("does not let a stale initial read overwrite a newer Selection event", async () => {
    const emitter = new Emitter<ModelSelectionView>();
    let resolveInitial!: (view: ModelSelectionView) => void;
    const initial = new Promise<ModelSelectionView>((resolve) => {
      resolveInitial = resolve;
    });
    const service = selectionService({ getView: vi.fn(() => initial), emitter });
    const { result } = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/workspace/app",
        sessionId: null,
        modelSelectionService: service,
      }),
    );

    act(() => emitter.fire(selectionView(2, true)));
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    await act(async () => resolveInitial(selectionView(1, false)));
    expect(result.current.agentStartupAllowed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("leaves the Host admission gate in charge when Selection View reading fails", async () => {
    const service = selectionService({
      getView: vi.fn(async () => {
        throw new Error("registry unavailable");
      }),
    });
    const { result } = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/workspace/app",
        sessionId: null,
        modelSelectionService: service,
      }),
    );

    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    expect(result.current.error).toBeNull();
  });
});
