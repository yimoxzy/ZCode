// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZhiliuRuntimeSelect } from "@/zhiliu-runtime-select/index.js";

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
    DropdownMenuRadioGroup: pass,
    DropdownMenuRadioItem: pass,
    DropdownMenuSeparator: pass,
    DropdownMenuTrigger: pass,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Desktop runtime selector request ownership", () => {
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
