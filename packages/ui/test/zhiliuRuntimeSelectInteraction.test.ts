// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ZhiliuRuntimeSelect,
  useZhiliuManagedDraftSelection,
} from "@/zhiliu-runtime-select/index.js";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";

const control = vi.hoisted(() => ({
  execute: vi.fn(),
  open: undefined as undefined | ((value: boolean) => void),
}));
vi.mock("@/hooks/usePlatform.js", () => {
  const platform = { executeDesktopCommand: control.execute };
  return { usePlatform: () => platform };
});
vi.mock("@/components/ui/dropdown-menu.js", () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
    }: {
      children?: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) => {
      control.open = onOpenChange;
      return createElement("div", null, children);
    },
    DropdownMenuContent: pass,
    DropdownMenuItem: pass,
    DropdownMenuLabel: pass,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children?: ReactNode;
      onValueChange: (value: string) => void;
    }) =>
      createElement(
        "div",
        {
          onClick: (event: { target: EventTarget | null }) => {
            const value = (event.target as HTMLElement)?.getAttribute("data-value");
            if (value) onValueChange(value);
          },
        },
        children,
      ),
    DropdownMenuRadioItem: ({
      children,
      value,
      disabled,
    }: {
      children?: ReactNode;
      value: string;
      disabled?: boolean;
    }) => createElement("button", { "data-value": value, disabled }, children),
    DropdownMenuSeparator: pass,
    DropdownMenuTrigger: pass,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  control.execute.mockReset();
});

describe("Desktop runtime selector request ownership", () => {
  const tierId = "00000000-0000-4000-8000-000000000001";
  const view = {
    catalog: {
      protocol_version: 1,
      agents: [],
      inference_profiles: [{ id: tierId, name: "快速", description: "" }],
    },
    selection: { agent_id: null, inference_profile_id: null },
  };
  const props = { workspacePath: "C:/project", workspaceIdentity: "one", disabled: false };

  it("refreshes the current Host only after a successful Main selection", async () => {
    const changed = vi.fn();
    control.execute.mockResolvedValueOnce(view).mockResolvedValueOnce({
      ...view,
      selection: { agent_id: null, inference_profile_id: tierId },
    });
    render(createElement(ZhiliuRuntimeSelect, { ...props, onSelectionChanged: changed }));
    await act(async () => {});
    expect(changed).not.toHaveBeenCalled();
    await act(async () => fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(control.execute.mock.lastCall?.[1]).toMatchObject({
      workspacePath: props.workspacePath,
      workspaceIdentity: props.workspaceIdentity,
      selection: { agent_id: null, inference_profile_id: tierId },
    });
  });

  it("failed/busy switching preserves the previous view and never requests a draft refresh", async () => {
    const changed = vi.fn();
    control.execute
      .mockResolvedValueOnce(view)
      .mockRejectedValueOnce(new Error("请等待本地任务结束后切换Agent或思考档位"));
    const ui = render(
      createElement(ZhiliuRuntimeSelect, { ...props, onSelectionChanged: changed }),
    );
    await act(async () => {});
    await act(async () => fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } }));
    expect(screen.getByRole("alert").textContent).toContain("请等待本地任务结束");
    expect(changed).not.toHaveBeenCalled();
    ui.rerender(
      createElement(ZhiliuRuntimeSelect, { ...props, disabled: true, onSelectionChanged: changed }),
    );
    await act(async () => fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } }));
    expect(control.execute).toHaveBeenCalledTimes(2);
  });

  it.each(["account", "workspace", "unmount"])(
    "ignores a late Set response after %s invalidation",
    async (reason) => {
      const changed = vi.fn();
      let finish!: (value: unknown) => void;
      control.execute.mockResolvedValueOnce(view).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const ui = render(
        createElement(ZhiliuRuntimeSelect, { ...props, onSelectionChanged: changed }),
      );
      await act(async () => {});
      await act(async () =>
        fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } }),
      );
      if (reason !== "unmount") control.execute.mockResolvedValueOnce(view);
      if (reason === "account")
        act(() => window.dispatchEvent(new Event("zhiliu-account-changed")));
      if (reason === "workspace")
        ui.rerender(
          createElement(ZhiliuRuntimeSelect, {
            ...props,
            workspaceIdentity: "two",
            onSelectionChanged: changed,
          }),
        );
      if (reason === "unmount") ui.unmount();
      await act(async () =>
        finish({ ...view, selection: { agent_id: null, inference_profile_id: tierId } }),
      );
      expect(changed).not.toHaveBeenCalled();
      if (reason !== "unmount")
        expect(screen.getByTestId("zhiliu-runtime-select").textContent).not.toContain("快速");
    },
  );

  it("auto-loads each rootless project's accepted header again on A/B/A switches without opening the menu", async () => {
    const first = {
      workspacePath: "C:/scratch/data/.zcode/workspace/734a8504-3196-4594-bdbd-f0c36ac0688e",
      disabled: false,
    };
    const second = {
      ...first,
      workspacePath: "C:/scratch/data/.zcode/workspace/5293e75a-0316-4f62-8f3d-df05907d89f2",
    };
    const highId = "00000000-0000-4000-8000-000000000002";
    const catalog = {
      ...view.catalog,
      inference_profiles: [
        ...view.catalog.inference_profiles,
        { id: highId, name: "深度", description: "" },
      ],
    };
    control.execute.mockImplementation(async (_command, target) => ({
      catalog,
      selection: {
        agent_id: null,
        inference_profile_id: target.workspacePath === first.workspacePath ? tierId : highId,
      },
    }));
    const changed = vi.fn();
    const ui = render(
      createElement(ZhiliuRuntimeSelect, { ...first, onSelectionChanged: changed }),
    );
    await act(async () => {});
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("通用对话 · 快速");
    ui.rerender(createElement(ZhiliuRuntimeSelect, { ...second, onSelectionChanged: changed }));
    await act(async () => {});
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("通用对话 · 深度");
    ui.rerender(createElement(ZhiliuRuntimeSelect, { ...first, onSelectionChanged: changed }));
    await act(async () => {});
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("通用对话 · 快速");
    expect(control.execute.mock.calls.map((call) => call[1])).toEqual(
      [first, second, first].map(({ workspacePath }) => ({ workspacePath })),
    );
    expect(
      control.execute.mock.calls.every((call) => call[0] === "getZhiliuRuntimeSelection"),
    ).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it("target switch hides the previous ready view while loading and ignores a late A refresh", async () => {
    const reads: Array<(value: unknown) => void> = [];
    control.execute
      .mockResolvedValueOnce({
        ...view,
        selection: { agent_id: null, inference_profile_id: tierId },
      })
      .mockImplementation(() => new Promise((resolve) => reads.push(resolve)));
    const ui = render(createElement(ZhiliuRuntimeSelect, props));
    await act(async () => {});
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("快速");
    await act(async () => control.open?.(true));
    ui.rerender(createElement(ZhiliuRuntimeSelect, { ...props, workspaceIdentity: "two" }));
    expect(control.execute.mock.lastCall?.[1]).toMatchObject({ workspaceIdentity: "two" });
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("正在读取平台配置");
    const oldAgentId = "00000000-0000-4000-8000-000000000001";
    await act(async () =>
      reads[0]!({
        catalog: {
          protocol_version: 1,
          agents: [{ id: oldAgentId, name: "旧空间Agent", description: "", version_id: null }],
          inference_profiles: [],
        },
        selection: { agent_id: oldAgentId, inference_profile_id: null },
      }),
    );
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).not.toContain("旧空间Agent");
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).not.toContain("默认思考");
    expect((screen.getByTestId("zhiliu-runtime-select") as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      reads[1]!({ ...view, selection: { agent_id: null, inference_profile_id: tierId } }),
    );
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("快速");
    expect((screen.getByTestId("zhiliu-runtime-select") as HTMLButtonElement).disabled).toBe(false);
  });

  it("late A cannot replace an already loaded B header", async () => {
    let late!: (value: unknown) => void;
    control.execute
      .mockReturnValueOnce(new Promise((resolve) => (late = resolve)))
      .mockResolvedValueOnce(view);
    const ui = render(createElement(ZhiliuRuntimeSelect, props));
    ui.rerender(createElement(ZhiliuRuntimeSelect, { ...props, workspaceIdentity: "two" }));
    await act(async () => {});
    await act(async () =>
      late({ ...view, selection: { agent_id: null, inference_profile_id: tierId } }),
    );
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("默认思考");
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).not.toContain("快速");
  });

  it("failed read is explicit rather than a default selection and opening the menu retries read-only", async () => {
    const changed = vi.fn();
    control.execute.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      ...view,
      selection: { agent_id: null, inference_profile_id: tierId },
    });
    render(createElement(ZhiliuRuntimeSelect, { ...props, onSelectionChanged: changed }));
    await act(async () => {});
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain(
      "配置读取失败，请重试",
    );
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).not.toContain("默认思考");
    await act(async () => control.open?.(true));
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("快速");
    expect(changed).not.toHaveBeenCalled();
    expect(
      control.execute.mock.calls.every((call) => call[0] === "getZhiliuRuntimeSelection"),
    ).toBe(true);
  });

  it("running disabled state still restores the read-only header and rejects Set", async () => {
    control.execute.mockResolvedValue({
      ...view,
      selection: { agent_id: null, inference_profile_id: tierId },
    });
    render(createElement(ZhiliuRuntimeSelect, { ...props, disabled: true }));
    await act(async () => {});
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("快速");
    expect((screen.getByTestId("zhiliu-runtime-select") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } }));
    expect(control.execute).toHaveBeenCalledOnce();
    expect(control.execute.mock.calls[0]?.[0]).toBe("getZhiliuRuntimeSelection");
  });

  it("maps the shared native slider's declared profile UUIDs and default null through Main while keeping the Agent", async () => {
    const agentId = "00000000-0000-4000-8000-000000000003";
    const nextId = "00000000-0000-4000-8000-000000000002";
    const catalogue = {
      ...view.catalog,
      agents: [{ id: agentId, name: "经营参谋", description: "", version_id: null }],
      // Platform order and labels deliberately do not imply low/high reasoning.
      inference_profiles: [
        { id: nextId, name: "平台档二", description: "" },
        { id: tierId, name: "平台档一", description: "" },
      ],
    };
    control.execute.mockImplementation(async (_command, input) => ({
      catalog: catalogue,
      selection: input.selection ?? { agent_id: agentId, inference_profile_id: null },
    }));
    const changed = vi.fn();
    render(createElement(ZhiliuRuntimeSelect, { ...props, onSelectionChanged: changed }));
    await act(async () => {});
    const slider = screen.getByRole("slider", { name: "思考档位" });
    expect(slider.getAttribute("data-levels")).toBe(JSON.stringify(["__default", nextId, tierId]));
    await act(async () => fireEvent.change(slider, { target: { value: "2" } }));
    expect(control.execute.mock.lastCall).toEqual([
      "setZhiliuRuntimeSelection",
      {
        workspacePath: props.workspacePath,
        workspaceIdentity: props.workspaceIdentity,
        selection: { agent_id: agentId, inference_profile_id: tierId },
      },
    ]);
    expect(slider.getAttribute("aria-valuetext")).toBe("平台档一");
    expect(screen.getByTestId("composer-thought-bubbles").children).toHaveLength(12);
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain(
      "经营参谋 · 平台档一",
    );
    await act(async () => fireEvent.change(slider, { target: { value: "0" } }));
    expect(control.execute.mock.lastCall?.[1].selection).toEqual({
      agent_id: agentId,
      inference_profile_id: null,
    });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("slider")).toBe(slider);
    expect(screen.queryByTestId("composer-provider-trigger")).toBeNull();
    expect(screen.queryByTestId("chat-model-select-trigger")).toBeNull();
  });

  it("keeps the accepted slider value, header and focus while a Set is pending or rejected", async () => {
    const highId = "00000000-0000-4000-8000-000000000002";
    const accepted = {
      catalog: {
        ...view.catalog,
        inference_profiles: [
          ...view.catalog.inference_profiles,
          { id: highId, name: "深度", description: "" },
        ],
      },
      selection: { agent_id: null, inference_profile_id: tierId },
    };
    let reject!: (error: Error) => void;
    control.execute.mockResolvedValueOnce(accepted).mockReturnValueOnce(
      new Promise((_resolve, failure) => {
        reject = failure;
      }),
    );
    const changed = vi.fn();
    render(createElement(ZhiliuRuntimeSelect, { ...props, onSelectionChanged: changed }));
    await act(async () => {});
    const slider = screen.getByRole("slider") as HTMLInputElement;
    slider.focus();
    await act(async () => fireEvent.change(slider, { target: { value: "2" } }));
    expect(slider.value).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("快速");
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("快速");
    expect(document.activeElement).toBe(slider);
    await act(async () => fireEvent.change(slider, { target: { value: "0" } }));
    expect(control.execute).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error("请等待本地任务结束后切换Agent或思考档位")));
    expect(slider.value).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("快速");
    expect(slider.getAttribute("aria-disabled")).toBe("false");
    expect(screen.getByRole("slider")).toBe(slider);
    expect(document.activeElement).toBe(slider);
    expect(screen.getByRole("alert").textContent).toContain("请等待本地任务结束");
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not infer a missing profile as default and accepts Home only as an explicit default request", async () => {
    const unavailable = "00000000-0000-4000-8000-000000000099";
    control.execute
      .mockResolvedValueOnce({
        ...view,
        selection: { agent_id: null, inference_profile_id: unavailable },
      })
      .mockResolvedValueOnce(view);
    render(createElement(ZhiliuRuntimeSelect, props));
    await act(async () => {});
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuetext")).toBe("—");
    expect(screen.getByTestId("composer-thought-track").getAttribute("data-progress")).toBe("0");
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).toContain("档位不可用");
    expect(control.execute).toHaveBeenCalledOnce();
    await act(async () => fireEvent.keyUp(slider, { key: "Home" }));
    expect(control.execute.mock.lastCall?.[1].selection).toEqual({
      agent_id: null,
      inference_profile_id: null,
    });
  });
});

describe("Managed next-turn selection is constrained by the current Host view", () => {
  const selection = {
    providerId: "zhiliu-managed",
    modelId: "zhiliu-managed",
    options: { reasoningLevel: "medium" },
  };
  const view = (levels = ["low"]): ModelSelectionView =>
    ({
      revision: 2,
      providers: [
        {
          providerId: "zhiliu-managed",
          config: {},
          models: [
            {
              modelId: "zhiliu-managed",
              config: { optionSpecs: { reasoningLevel: { values: levels, map: "{}" } } },
            },
          ],
        },
      ],
    }) as ModelSelectionView;
  it("Web attachment owner change immediately hides the old ready catalogue and ignores its late read", async () => {
    const changed = vi.fn();
    const oldReads: Array<(value: ModelSelectionView) => void> = [];
    const newReads: Array<(value: ModelSelectionView) => void> = [];
    const oldService: IModelSelectionService = {
      getView: () => new Promise((resolve) => oldReads.push(resolve)),
      onDidChange: () => ({ dispose: vi.fn() }),
    };
    const newService: IModelSelectionService = {
      getView: () => new Promise((resolve) => newReads.push(resolve)),
      onDidChange: () => ({ dispose: vi.fn() }),
    };
    const draftSelection = { ...selection, options: { reasoningLevel: "low" } };
    const hook = renderHook(
      ({ service }) => {
        const read = useModelSelectionServiceView(service, true, "remote-waiting", {
          selection: draftSelection,
        });
        useZhiliuManagedDraftSelection({
          enabled: true,
          modelSelectionState: read.state,
          draftSelection,
          onSelectModel: changed,
        });
        return read;
      },
      { initialProps: { service: oldService } },
    );
    await act(async () => oldReads[0]!(view()));
    expect(hook.result.current.state.status).toBe("ready");
    expect(changed).not.toHaveBeenCalled();
    act(() => hook.result.current.reload());
    hook.rerender({ service: newService });
    expect(hook.result.current.state.status).toBe("loading");
    await act(async () => oldReads[1]!(view(["medium"])));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => newReads[0]!(view(["high"])));
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      "zhiliu-managed",
      "zhiliu-managed",
      { provider: "zhiliu-managed", model: "zhiliu-managed" },
      "high",
    );
    expect(control.execute).not.toHaveBeenCalled();
  });
  it.each([
    { status: "loading", catalog: view() },
    { status: "error", error: new Error("offline") },
    { status: "unavailable", reason: "remote-waiting" },
    { status: "ready", view: view(), refreshError: { revision: 3, error: new Error("offline") } },
    { status: "ready", view: view(["low", "high"]) },
    { status: "ready", view: view([]) },
    { status: "ready", view: { revision: 3, providers: [] } },
  ] as ModelSelectionState[])(
    "does not normalize an unavailable, failed or ambiguous authorization (%#)",
    (state) => {
      const changed = vi.fn();
      renderHook(() =>
        useZhiliuManagedDraftSelection({
          enabled: true,
          modelSelectionState: state,
          draftSelection: selection,
          onSelectModel: changed,
        }),
      );
      expect(changed).not.toHaveBeenCalled();
    },
  );
  it("does not reinterpret a personal or unknown model or overwrite a valid managed intent", () => {
    const changed = vi.fn();
    const { rerender } = renderHook(
      ({ draftSelection, enabled }) =>
        useZhiliuManagedDraftSelection({
          enabled,
          modelSelectionState: { status: "ready", view: view() },
          draftSelection,
          onSelectModel: changed,
        }),
      { initialProps: { enabled: true, draftSelection: { ...selection, providerId: "personal" } } },
    );
    rerender({ enabled: true, draftSelection: { ...selection, modelId: "unknown" } });
    rerender({
      enabled: true,
      draftSelection: { ...selection, options: { reasoningLevel: "low" } },
    });
    rerender({ enabled: false, draftSelection: selection });
    expect(changed).not.toHaveBeenCalled();
  });
});
