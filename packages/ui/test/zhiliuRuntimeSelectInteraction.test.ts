// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ executeDesktopCommand: control.execute }),
}));
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
    await act(async () => control.open?.(true));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "快速" })));
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
    await act(async () => control.open?.(true));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "快速" })));
    expect(screen.getByRole("alert").textContent).toContain("请等待本地任务结束");
    expect(changed).not.toHaveBeenCalled();
    ui.rerender(
      createElement(ZhiliuRuntimeSelect, { ...props, disabled: true, onSelectionChanged: changed }),
    );
    await act(async () => control.open?.(true));
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
      await act(async () => control.open?.(true));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "快速" })));
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

  it("switching workspace clears old busy state and ignores a late catalog response", async () => {
    let finish!: (value: unknown) => void;
    control.execute.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const props = { workspacePath: "C:/project", workspaceIdentity: "one", disabled: false };
    const ui = render(createElement(ZhiliuRuntimeSelect, props));
    await act(async () => control.open?.(true));
    expect((screen.getByTestId("zhiliu-runtime-select") as HTMLButtonElement).disabled).toBe(true);
    ui.rerender(createElement(ZhiliuRuntimeSelect, { ...props, workspaceIdentity: "two" }));
    expect((screen.getByTestId("zhiliu-runtime-select") as HTMLButtonElement).disabled).toBe(false);
    const oldAgentId = "00000000-0000-4000-8000-000000000001";
    await act(async () =>
      finish({
        catalog: {
          protocol_version: 1,
          agents: [{ id: oldAgentId, name: "旧空间Agent", description: "", version_id: null }],
          inference_profiles: [],
        },
        selection: { agent_id: oldAgentId, inference_profile_id: null },
      }),
    );
    expect(screen.getByTestId("zhiliu-runtime-select").textContent).not.toContain("旧空间Agent");
    control.execute.mockResolvedValueOnce({
      catalog: { protocol_version: 1, agents: [], inference_profiles: [] },
      selection: { agent_id: null, inference_profile_id: null },
    });
    await act(async () => control.open?.(true));
    expect(control.execute.mock.lastCall?.[1]).toMatchObject({ workspaceIdentity: "two" });
    expect((screen.getByTestId("zhiliu-runtime-select") as HTMLButtonElement).disabled).toBe(false);
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
