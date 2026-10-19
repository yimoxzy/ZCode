import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@zcode/shared";
import { parseClientConfigSnapshot } from "@zcode/shared";
import type { IOAuthService } from "../src/oauth/oauth.js";
import { OfficialCloudDisabledError } from "../src/zhiliu/officialCloudPolicy.js";

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));
vi.mock("../src/feedback/feedbackHttpClient.js", () => ({
  FeedbackHttpClient: vi.fn(),
  FeedbackUploadCanceledError: class extends Error {},
}));
vi.mock("../src/feedback/feedbackLocalTicketStore.js", () => ({
  FeedbackLocalTicketStore: vi.fn(),
}));
vi.mock("../src/feedback/compactLogArchive.js", () => ({
  prepareCompactLogArchive: vi.fn().mockResolvedValue({ path: "local-log.zip", size: 12 }),
  cleanupLogArchive: vi.fn().mockResolvedValue(undefined),
}));

import { createFeedbackService } from "../src/feedback/feedbackService.js";
import { createClientConfigService } from "../src/client-config/clientConfigService.js";
import { FeedbackHttpClient } from "../src/feedback/feedbackHttpClient.js";
import { FeedbackLocalTicketStore } from "../src/feedback/feedbackLocalTicketStore.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "../src/feedback/compactLogArchive.js";

const request = vi.fn();
const apiClient = { request } as unknown as ApiClient;
const credentialService = { load: vi.fn(), save: vi.fn(), delete: vi.fn() };
const oauthService = { getAuthHeaders: vi.fn(), getActiveProvider: vi.fn() };
const getDeviceMid = vi.fn();
const createFullLogArchive = vi.fn();
const revealPath = vi.fn().mockResolvedValue(undefined);

function feedbackService() {
  return createFeedbackService({
    apiClient,
    credentialService,
    oauthService: oauthService as unknown as IOAuthService,
    getDeviceMid,
    createFullLogArchive,
    revealPath,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("织流官方反馈与客户端配置边界", () => {
  it("公开配置为空且使用独立合法快照，不解析上下文或发起强制刷新请求", async () => {
    const resolveRequestContext = vi.fn();
    const service = createClientConfigService({ apiClient, resolveRequestContext });
    const expected = parseClientConfigSnapshot({ code: 0, data: { configs: {} } });
    const snapshot = await service.getSnapshot();
    expect(snapshot).toEqual(expected);
    snapshot.zsrcUrl = "https://local.example/changed";
    expect(await service.getSnapshot({ forceRefresh: true })).toEqual(expected);
    expect(resolveRequestContext).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await expect(
      service.getSnapshot({ forceRefresh: "invalid" } as unknown as { forceRefresh: boolean }),
    ).rejects.toThrow();
  });

  it("所有远端反馈命令在 HTTP、工单存储和凭据初始化前明确拒绝", async () => {
    const service = feedbackService();
    const operations = [
      () => service.create({ title: "test", description: "test", type: "bug" }),
      () => service.list(),
      () => service.get("ticket"),
      () => service.comment("ticket", "comment"),
      () => service.uploadAttachment("ticket", "image", { path: "local.png" }),
      () =>
        service.uploadAttachmentWithProgress("ticket", "image", { path: "local.png" }, "progress"),
      () =>
        service.uploadAttachmentData("ticket", "image", {
          filename: "local.png",
          dataBase64: "cHJpdmF0ZQ==",
          contentType: "image/png",
        }),
      () => service.attachLogsFromExport("ticket", { full: true }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(OfficialCloudDisabledError);
      await expect(operation()).rejects.toMatchObject({
        code: "zhiliu_official_cloud_disabled",
      });
    }
    expect(FeedbackHttpClient).not.toHaveBeenCalled();
    expect(FeedbackLocalTicketStore).not.toHaveBeenCalled();
    expect(credentialService.load).not.toHaveBeenCalled();
    expect(credentialService.save).not.toHaveBeenCalled();
    expect(credentialService.delete).not.toHaveBeenCalled();
    expect(oauthService.getAuthHeaders).not.toHaveBeenCalled();
    expect(oauthService.getActiveProvider).not.toHaveBeenCalled();
    expect(getDeviceMid).not.toHaveBeenCalled();
    expect(prepareCompactLogArchive).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("取消及进度订阅只在本机执行，本地日志导出与清理保留接口", async () => {
    const service = feedbackService();
    const listener = vi.fn();
    const subscription = service.onDynamicUploadProgress("progress")(listener);
    await service.cancelCreate("create");
    await service.cancelCreate("create");
    await service.cancelUpload("progress");
    subscription.dispose();
    expect(listener).not.toHaveBeenCalled();
    expect(await service.getDeviceSnapshot()).toMatchObject({ nodeVersion: process.version });
    expect(await service.prepareCompactLogArchive({ full: true })).toEqual({
      path: "local-log.zip",
      size: 12,
    });
    expect(prepareCompactLogArchive).toHaveBeenCalledWith(
      expect.objectContaining({ full: true, createFullArchive: createFullLogArchive }),
    );
    await service.cleanupPreparedLogArchive("local-log.zip");
    expect(cleanupLogArchive).toHaveBeenCalledWith("local-log.zip");
    await service.revealLogArchive("local-log.zip");
    expect(revealPath).toHaveBeenCalledWith("local-log.zip");
    expect(FeedbackHttpClient).not.toHaveBeenCalled();
    expect(credentialService.load).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
