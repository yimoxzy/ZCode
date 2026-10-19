import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, AppUsageSnapshot } from "@zcode/shared";
import { ProviderConfigMap } from "@zcode/provider";
import {
  createApiKeyProviderConfig,
  createAccountProviderConfig,
} from "./providerConfigFixtures.js";

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));

import { createCodingPlanSubscriptionService } from "../src/coding-plan-subscription/codingPlanSubscriptionService.js";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";
import { createOAuthService } from "../src/oauth/oauthService.js";
import { createAccountProviderConnectionResolver } from "../src/model-provider/accountProviderConnectionResolver.js";
import { fetchZCodeBuiltinRemoteRelease } from "../src/model-provider/zcodeBuiltinRemoteConfig.js";

const request = vi.fn();
const apiClient = { request } as unknown as ApiClient;
const credentialService = { load: vi.fn(), save: vi.fn(), delete: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe("织流 Host 官方服务隔离", () => {
  it("官方套餐读取返回空目录/disabled，支付明确拒绝，不调用网络或凭据", async () => {
    const service = createCodingPlanSubscriptionService({ apiClient, credentialService });
    expect(await service.getStaticProducts()).toEqual({});
    expect(await service.getStaticTeamProducts()).toEqual({});
    expect(await service.getEnterprisePricing({ authenticated: true })).toEqual({
      productList: [],
    });
    expect(await service.getManualClaimPlanPreviews()).toEqual({ plans: [] });
    expect(await service.getDynamicWorkflowClientConfig()).toMatchObject({
      enabled: false,
      mode: "disabled",
    });
    expect(await service.getOffPeakClientConfig()).toMatchObject({ enabled: false });
    expect(await service.getForceUpdateConfig()).toBeNull();
    await expect(service.batchPreview()).rejects.toMatchObject({
      code: "zhiliu_official_cloud_disabled",
    });
    expect(request).not.toHaveBeenCalled();
    expect(credentialService.load).not.toHaveBeenCalled();
  });

  it("OAuth不枚举、不读旧凭据、不恢复/刷新/启动官方会话", async () => {
    const service = createOAuthService(credentialService, { apiClient });
    expect(await service.getProviders()).toEqual([]);
    expect(await service.getActiveProvider()).toBeNull();
    expect(await service.restoreCachedSessionState()).toEqual({ status: "signed-out" });
    expect(await service.restoreSession()).toBeNull();
    expect(await service.pollPendingOAuth()).toBeNull();
    expect(await service.handleCallback("zhiliu://oauth/callback?code=example")).toBeNull();
    await expect(service.startOAuth("zai")).rejects.toMatchObject({
      code: "zhiliu_official_cloud_disabled",
    });
    await expect(service.startOAuthWithPolling("zai")).rejects.toMatchObject({
      code: "zhiliu_official_cloud_disabled",
    });
    await expect(service.refreshToken()).rejects.toMatchObject({
      code: "zhiliu_official_cloud_disabled",
    });
    await service.logoutAll();
    expect(credentialService.load).not.toHaveBeenCalled();
    expect(credentialService.save).not.toHaveBeenCalled();
    expect(credentialService.delete).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("账号解析器只处理官方Account，个人供应商由上层托管策略屏蔽", async () => {
    const readSettings = vi.fn();
    const loadAccountIdentity = vi.fn();
    const loadCodingPlanApiKey = vi.fn();
    const resolveFamilyAvailability = vi.fn();
    const resolver = createAccountProviderConnectionResolver({
      readSettings,
      loadAccountIdentity,
      loadCodingPlanApiKey,
      resolveFamilyAvailability,
    });
    const personal = createApiKeyProviderConfig({
      apiKey: "user-owned-key",
      baseURL: "https://api.z.ai/api/coding/paas/v4",
      models: ["glm-5"],
    });
    const providers = new ProviderConfigMap([
      ["official-plan", createAccountProviderConfig()],
      ["personal-byok", personal],
    ]);
    expect(await resolver({ configuredProviders: providers })).toEqual([
      { providerId: "official-plan", status: "unavailable", unavailableReason: "not-connected" },
    ]);
    expect(providers.get("personal-byok")).toBe(personal);
    expect(readSettings).not.toHaveBeenCalled();
    expect(loadAccountIdentity).not.toHaveBeenCalled();
    expect(loadCodingPlanApiKey).not.toHaveBeenCalled();
    expect(resolveFamilyAvailability).not.toHaveBeenCalled();
  });

  it("本地用量保持Agent数据库来源，官方额度不会冒充平台积分", async () => {
    const appUsage = { generatedAt: 123 } as AppUsageSnapshot;
    const getAppUsageStats = vi.fn().mockResolvedValue(appUsage);
    const service = createUsageStatsService({
      apiClient,
      credentialService,
      accountRequestAuthService: {
        resolveAccessCurrent: vi.fn(),
        resolveCurrent: vi.fn(),
        assertCurrent: vi.fn(),
      },
      zcodeAgentService: { getAppUsageStats },
    });
    expect(await service.getAppUsageSnapshot({ range: "7d", timeZone: "Asia/Shanghai" })).toBe(
      appUsage,
    );
    expect(getAppUsageStats).toHaveBeenCalledWith({ range: "7d", timeZone: "Asia/Shanghai" });
    expect(await service.getEntitlementSnapshot()).toMatchObject({
      authenticated: false,
      unavailableReason: "not_configured",
      remaining: null,
    });
    await expect(service.getCodingPlanUsageSnapshot({ range: "7d" })).rejects.toMatchObject({
      code: "zhiliu_official_cloud_disabled",
    });
    expect(request).not.toHaveBeenCalled();
    expect(credentialService.load).not.toHaveBeenCalled();
  });

  it("内置模型远端配置刷新不访问官方CDN", async () => {
    expect(
      await fetchZCodeBuiltinRemoteRelease({
        apiClient,
        endpointOrigin: "https://official.example",
        appVersion: "1.0.0",
        platform: "windows",
      }),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
