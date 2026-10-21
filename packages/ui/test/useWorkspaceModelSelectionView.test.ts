// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";

const mocks = vi.hoisted(() => {
  const getView = vi.fn<() => Promise<ModelSelectionView>>();
  return {
    managed: false,
    connectionKind: "local-ready" as "local-ready" | "remote-waiting",
    getView,
    services: {
      modelSelectionService: {
        getView,
        onDidChange: () => ({ dispose: vi.fn() }),
      } as IModelSelectionService,
    },
  };
});

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZHILIU_DESKTOP_ENABLED() {
    return mocks.managed;
  },
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({
    connectionKind: mocks.connectionKind,
    services: mocks.services,
  }),
}));

describe("useModelSelectionView target lifecycle", () => {
  beforeEach(() => {
    mocks.managed = false;
    mocks.connectionKind = "local-ready";
    mocks.getView.mockReset();
    mocks.getView.mockResolvedValue({ revision: 1, providers: [] });
  });

  it("托管原生与 Web 远控均携带当前路径及 identity，缺失路径不发授权", async () => {
    mocks.managed = true;
    const hook = renderHook(
      ({ path, identity }) => useModelSelectionView(path, "remote-1", identity),
      {
        initialProps: { path: "/same" as string | null, identity: "space:one" },
      },
    );
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    expect(mocks.getView).toHaveBeenLastCalledWith({
      selection: null,
      workspace: {
        workspacePath: "/same",
        workspaceIdentity: "space:one",
      },
    });
    hook.rerender({ path: "/same", identity: "space:two" });
    await waitFor(() =>
      expect(mocks.getView).toHaveBeenLastCalledWith({
        selection: null,
        workspace: {
          workspacePath: "/same",
          workspaceIdentity: "space:two",
        },
      }),
    );
    hook.rerender({ path: null, identity: "space:two" });
    expect(hook.result.current.state).toEqual({ status: "unavailable", reason: "missing-target" });
    expect(mocks.getView).toHaveBeenCalledTimes(2);
  });

  it("missing target 明确 unavailable 且不读取 Base Host", async () => {
    const hook = renderHook(() => useModelSelectionView(null));

    await act(async () => Promise.resolve());
    expect(hook.result.current.state).toEqual({
      status: "unavailable",
      reason: "missing-target",
    });
    expect(mocks.getView).not.toHaveBeenCalled();
  });

  it("remote waiting 不回退 Local Host，连接完成后读取目标 View", async () => {
    mocks.connectionKind = "remote-waiting";
    const hook = renderHook(() => useModelSelectionView("/remote/project", "remote-1"));

    await act(async () => Promise.resolve());
    expect(hook.result.current.state).toEqual({
      status: "unavailable",
      reason: "remote-waiting",
    });
    expect(mocks.getView).not.toHaveBeenCalled();

    mocks.connectionKind = "local-ready";
    hook.rerender();
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    expect(mocks.getView).toHaveBeenCalledTimes(1);
  });
});
