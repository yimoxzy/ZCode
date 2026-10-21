// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";
import { ZhiliuAccountControls } from "@/root/ZhiliuAccountControls.js";
import { useZhiliuAccount } from "@/hooks/useZhiliuAccount.js";

const state = vi.hoisted(() => ({
  account: { phase: "logged_out" } as Record<string, unknown>,
  executeDesktopCommand: vi.fn<(command: string) => Promise<unknown>>(),
  locale: "zh-CN",
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => state }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ locale: state.locale }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
beforeEach(() => {
  state.account = { phase: "logged_out" };
  state.locale = "zh-CN";
  state.executeDesktopCommand
    .mockReset()
    .mockImplementation(async () => state.account);
});
afterEach(cleanup);

describe("织流桌面账号入口", () => {
  it("登录与退出立即刷新同窗口其他账号视图，无需等待轮询", async () => {
    function AccountObserver() {
      const { account } = useZhiliuAccount();
      return createElement(
        "output",
        { "data-testid": "account-observer" },
        account.phase,
      );
    }
    render(
      createElement(
        "div",
        null,
        createElement(ZhiliuAccountControls),
        createElement(AccountObserver),
      ),
    );
    await waitFor(() =>
      expect(state.executeDesktopCommand).toHaveBeenCalledWith(
        DesktopCommandIds.GetZhiliuAccount,
      ),
    );
    state.executeDesktopCommand.mockImplementation(async (command) => {
      if (command === DesktopCommandIds.LoginZhiliu)
        state.account = { phase: "authenticated" };
      if (command === DesktopCommandIds.LogoutZhiliu)
        state.account = { phase: "logged_out" };
      return state.account;
    });
    fireEvent.click(screen.getByRole("button", { name: "登录织流" }));
    await waitFor(() =>
      expect(screen.getByTestId("account-observer").textContent).toBe(
        "authenticated",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() =>
      expect(screen.getByTestId("account-observer").textContent).toBe(
        "logged_out",
      ),
    );
  });
  it("网络不可用时仍可退出本机账号", async () => {
    state.account = { phase: "unavailable" };
    render(createElement(ZhiliuAccountControls));
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    await waitFor(() =>
      expect(state.executeDesktopCommand).toHaveBeenCalledWith(
        DesktopCommandIds.LogoutZhiliu,
      ),
    );
  });
  it("登录从Main读取身份投影，退出取消后保持原账号", async () => {
    render(createElement(ZhiliuAccountControls));
    await waitFor(() =>
      expect(state.executeDesktopCommand).toHaveBeenCalledWith(
        DesktopCommandIds.GetZhiliuAccount,
      ),
    );
    state.executeDesktopCommand.mockImplementation(async (command) => {
      if (command === DesktopCommandIds.LoginZhiliu)
        state.account = {
          phase: "authenticated",
          user: { nickname: "小春" },
          space: { name: "公司" },
        };
      if (command === DesktopCommandIds.LogoutZhiliu)
        return { confirmed: false, remoteRevoked: false };
      return state.account;
    });
    fireEvent.click(screen.getByRole("button", { name: "登录织流" }));
    expect(await screen.findByText("小春 · 公司")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() =>
      expect(state.executeDesktopCommand).toHaveBeenCalledWith(
        DesktopCommandIds.LogoutZhiliu,
      ),
    );
    expect(screen.getByText("小春 · 公司")).toBeTruthy();
  });

  it("取消等待后，迟到的登录完成不能覆盖已退出投影", async () => {
    let finish!: (value: unknown) => void;
    render(createElement(ZhiliuAccountControls));
    await waitFor(() => expect(state.executeDesktopCommand).toHaveBeenCalled());
    state.executeDesktopCommand.mockImplementation(async (command) => {
      if (command === DesktopCommandIds.LoginZhiliu)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return state.account;
    });
    fireEvent.click(screen.getByRole("button", { name: "登录织流" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消登录" }));
    await screen.findByRole("button", { name: "登录织流" });
    await act(async () =>
      finish({ phase: "authenticated", user: { nickname: "迟到账号" } }),
    );
    expect(screen.queryByText("迟到账号")).toBeNull();
    expect(screen.getByRole("button", { name: "登录织流" })).toBeTruthy();
  });

  it("支持英文并对失败只显示固定文案", async () => {
    state.locale = "en-US";
    render(createElement(ZhiliuAccountControls));
    await waitFor(() => expect(state.executeDesktopCommand).toHaveBeenCalled());
    state.executeDesktopCommand.mockRejectedValue(
      new Error("secret login_token"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Zhiliu" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Account connection unavailable. Please retry.",
    );
    expect(screen.queryByText(/secret/)).toBeNull();
  });
});
