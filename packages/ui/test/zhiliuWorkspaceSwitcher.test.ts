// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";
import { ZhiliuWorkspaceSwitcher } from "@/root/ZhiliuWorkspaceSwitcher.js";

const state = vi.hoisted(() => ({
  executeDesktopCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  locale: "zh-CN",
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => state }));
vi.mock("@/i18n/IntlProvider.js", () => ({ useZCodeIntl: () => ({ locale: state.locale }) }));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

beforeEach(() => {
  state.locale = "zh-CN";
  state.executeDesktopCommand.mockReset().mockResolvedValue({ opened: true });
});
afterEach(cleanup);

describe("织流双入口", () => {
  it("云入口通过窄平台命令打开，不直接读取账号或拼接外部地址", async () => {
    const onOpenLocal = vi.fn();
    render(createElement(ZhiliuWorkspaceSwitcher, { onOpenLocal }));
    fireEvent.click(screen.getByTestId("zhiliu-open-cloud"));
    await waitFor(() =>
      expect(state.executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(
        DesktopCommandIds.OpenZhiliuCloud,
      ),
    );
    expect(onOpenLocal).not.toHaveBeenCalled();
    expect(screen.getByText("登录织流 · 模型由平台统一管理")).toBeTruthy();
  });

  it("本地入口复用工作区打开动作", () => {
    const onOpenLocal = vi.fn();
    render(createElement(ZhiliuWorkspaceSwitcher, { onOpenLocal }));
    fireEvent.click(screen.getByTestId("zhiliu-open-local"));
    expect(onOpenLocal).toHaveBeenCalledOnce();
    expect(state.executeDesktopCommand).not.toHaveBeenCalled();
    expect(screen.getByTestId("zhiliu-open-local").getAttribute("aria-current")).toBe("page");
  });

  it("云入口失败后显示可重试状态，重试成功会清除错误", async () => {
    state.executeDesktopCommand.mockRejectedValueOnce(new Error("unavailable"));
    render(createElement(ZhiliuWorkspaceSwitcher, { onOpenLocal: vi.fn() }));
    fireEvent.click(screen.getByTestId("zhiliu-open-cloud"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("zhiliu-open-cloud").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByTestId("zhiliu-open-cloud"));
    await waitFor(() => expect(state.executeDesktopCommand).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("Main 已处理的失败回执仍允许重试，成功回执清除提示", async () => {
    state.executeDesktopCommand.mockResolvedValueOnce({ opened: false });
    render(createElement(ZhiliuWorkspaceSwitcher, { onOpenLocal: vi.fn() }));
    const button = screen.getByTestId("zhiliu-open-cloud");
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(state.executeDesktopCommand).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("等待打开结果期间禁用云入口，阻止重复派发", async () => {
    let finishOpening!: (result: { opened: boolean }) => void;
    state.executeDesktopCommand.mockImplementationOnce(
      () => new Promise((resolve) => (finishOpening = resolve)),
    );
    render(createElement(ZhiliuWorkspaceSwitcher, { onOpenLocal: vi.fn() }));
    const button = screen.getByTestId("zhiliu-open-cloud");
    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(state.executeDesktopCommand).toHaveBeenCalledOnce();
    await act(async () => finishOpening({ opened: true }));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
