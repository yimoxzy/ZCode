// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";

const state = vi.hoisted(() => ({
  feedbackCenter: vi.fn(() => null),
  inventory: vi.fn(() => {
    throw new Error("official inventory must not mount");
  }),
  oauthService: {
    getProviders: vi.fn(),
    getActiveProvider: vi.fn(),
    startOAuthWithPolling: vi.fn(),
    restoreCachedSessionState: vi.fn(),
    handleCallback: vi.fn(),
  },
  platform: {
    openExternal: vi.fn(),
    notifyRendererReady: vi.fn(),
    onOAuthCallback: vi.fn(),
  },
  setOAuthPollingActive: vi.fn(),
}));

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ oauthService: state.oauthService }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => state.platform }));
vi.mock("@/hooks/useAlertDialog.js", () => ({ useAlertDialog: () => vi.fn() }));
vi.mock("@/hooks/useCodingPlanEntryPlanList.js", () => ({
  useCodingPlanEntryPlanList: state.inventory,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (
    select: (value: { setOAuthPollingActive: typeof state.setOAuthPollingActive }) => unknown,
  ) => select({ setOAuthPollingActive: state.setOAuthPollingActive }),
}));
vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/feedback/FeedbackCenter.js", () => ({ FeedbackCenter: state.feedbackCenter }));

import {
  CodingPlanUpgradeDialogProvider,
  useCodingPlanUpgradeDialog,
} from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RewardsProvider, useOpenRewards } from "@/rewards/RewardsProvider.js";
import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { useOAuth } from "@/hooks/useOAuth.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { FeedbackHost } from "@/feedback/FeedbackHost.js";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("织流官方云流程隔离", () => {
  it("不挂载上游反馈表单、工单和后台上传", () => {
    const { container } = render(
      createElement(FeedbackHost, {
        platform: state.platform as unknown as IPlatformService,
      }),
    );
    expect(container.innerHTML).toBe("");
    expect(state.feedbackCenter).not.toHaveBeenCalled();
  });
  it("禁用套餐保持context但不读取商品目录或打开购买", () => {
    let result: boolean | undefined;
    function Probe() {
      const value = useCodingPlanUpgradeDialog();
      return createElement(
        "button",
        {
          onClick: () => {
            result = value.openCodingPlanUpgrade({ providerId: "zai" });
          },
        },
        value.inventory.entryPlanList || "empty",
      );
    }
    render(
      createElement(CodingPlanUpgradeDialogProvider, {
        enabled: false,
        children: createElement(Probe),
      }),
    );
    fireEvent.click(screen.getByText("empty"));
    expect(result).toBe(false);
    expect(state.inventory).not.toHaveBeenCalled();
  });

  it("禁用Rewards和营销不挂载有副作用的内部实现", () => {
    function Probe() {
      const rewards = useOpenRewards();
      return createElement("span", null, rewards === null ? "disabled" : "enabled");
    }
    render(
      createElement(RewardsProvider, {
        desktop: true,
        enabled: false,
        children: createElement(MarketingTouchProvider, {
          desktop: true,
          enabled: false,
          children: createElement(Probe),
        }),
      }),
    );
    expect(screen.getByText("disabled")).toBeTruthy();
    expect(state.platform.openExternal).not.toHaveBeenCalled();
  });

  it("OAuth hook拒绝枚举和启动上游授权", async () => {
    const { result } = renderHook(() => useOAuth());
    await result.current.startLogin("zai");
    expect(result.current.loadingProviders).toBe(false);
    expect(result.current.providers).toEqual([]);
    expect(state.oauthService.getProviders).not.toHaveBeenCalled();
    expect(state.oauthService.startOAuthWithPolling).not.toHaveBeenCalled();
    expect(state.platform.openExternal).not.toHaveBeenCalled();
  });

  it("禁用OAuth生命周期仍通知renderer就绪，不恢复官方凭据和订阅回调", () => {
    const setRestoring = vi.fn();
    renderHook(() =>
      useRootOAuthEffects({
        enabled: false,
        accountIntentKey: "local",
        platform: state.platform as unknown as IPlatformService,
        services: { oauthService: state.oauthService } as unknown as IServiceAccessor,
        refreshProviderState: vi.fn(),
        setUser: vi.fn(),
        setIsRestoringOAuthSession: setRestoring,
        setOAuthError: vi.fn(),
        oauthPollingActive: true,
        setOAuthPollingActive: vi.fn(),
        markOAuthSuccess: vi.fn(),
        onReauthenticationRequired: vi.fn(),
      }),
    );
    expect(setRestoring).toHaveBeenCalledWith(false);
    expect(state.platform.notifyRendererReady).toHaveBeenCalledOnce();
    expect(state.oauthService.restoreCachedSessionState).not.toHaveBeenCalled();
    expect(state.platform.onOAuthCallback).not.toHaveBeenCalled();
  });

  it("不展示会上传内容到上游的分享入口", () => {
    const { container } = render(createElement(ConversationShareMenu, { taskId: "local-task" }));
    expect(container.innerHTML).toBe("");
  });
});
