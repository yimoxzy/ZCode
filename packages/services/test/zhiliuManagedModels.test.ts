import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsFacade } from "@zcode/provider";

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZHILIU_DESKTOP_ENABLED: true,
}));

import {
  createProviderConfigRuntime,
  type ProviderConfigRuntimeOptions,
} from "../src/model-provider/providerConfigRuntime.js";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { createProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";
import {
  createProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "../src/model-provider/providerProvisioningSource.js";
import {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "../src/model-provider/providerProvisioningTarget.js";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";

function unreadableOptions<T extends object>(): T {
  return new Proxy({} as T, {
    get(_target, key) {
      throw new Error(`不应读取被禁用的配置来源: ${String(key)}`);
    },
  });
}

describe("织流只允许平台托管模型", () => {
  it("不读取个人/内置文件、legacy 回调或远端配置；仓库为只读空目录", async () => {
    const runtime = createProviderConfigRuntime(unreadableOptions<ProviderConfigRuntimeOptions>());
    try {
      await runtime.start();
      const config = await runtime.configService.read();
      expect(config.zcodeBuiltinProviders.keys()).toEqual([]);
      expect(config.personalProviders.keys()).toEqual([]);
      expect(config.zcodeBuiltinProviderTemplates.keys()).toEqual([]);
      expect(await runtime.refreshZCodeBuiltin({ force: true })).toBe("skipped");
      const transform = vi.fn();
      await expect(runtime.personalRepository.update(transform)).rejects.toMatchObject({
        code: "zhiliu_managed_models_only",
      });
      expect(transform).not.toHaveBeenCalled();
      await expect(runtime.resolveZCodeBuiltinActiveFilePath()).rejects.toMatchObject({
        code: "zhiliu_desktop_inference_unavailable",
      });
    } finally {
      runtime.dispose();
    }
  });

  it("真实 ProviderRuntime 发布空选择，不从旧配置或账号状态恢复模型", async () => {
    const legacy = vi.fn();
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath: "missing-builtin-must-not-be-read.json",
      personalFilePath: "missing-personal-must-not-be-read.json",
      readLegacyProviders: legacy,
    });
    try {
      await runtime.start();
      expect((await runtime.providerSettings.getView()).providers).toEqual([]);
      expect((await runtime.modelSelection.getView()).providers).toEqual([]);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
    }
  });

  it("直接 ProviderSettings RPC 也不能写入个人供应商、解析凭据或测试任意端点", async () => {
    const onDidChange = vi.fn(() => () => {});
    const facade = new Proxy(
      { onDidChange },
      {
        get(target, key) {
          if (key === "onDidChange") return target.onDidChange;
          throw new Error(`禁用 RPC 不应访问 facade: ${String(key)}`);
        },
      },
    ) as unknown as ProviderSettingsFacade;
    const ensureReady = vi.fn();
    const connectivity = vi.fn();
    const service = createProviderSettingsService(facade, ensureReady, connectivity);
    const operations = [
      "createPersonalProvider",
      "resolveModelConfig",
      "savePersonalProviderOverlay",
      "deletePersonalProvider",
      "reorderPersonalProviders",
      "reorderPersonalModels",
      "addPersonalModel",
      "renamePersonalModel",
      "deletePersonalModel",
      "savePersonalModelDraft",
      "setPersonalModelEnabled",
      "testModelConnectivity",
    ] as const;
    for (const operation of operations) {
      await expect(
        Reflect.apply(service[operation], service, [
          {
            baseUrl: "https://untrusted.example",
            apiKey: "must-never-be-read",
          },
        ]),
      ).rejects.toMatchObject({ code: "zhiliu_managed_models_only" });
    }
    expect(ensureReady).not.toHaveBeenCalled();
    expect(connectivity).not.toHaveBeenCalled();
  });

  it("阻止跨环境导出/导入个人配置；不读取任意 Store 或写入 Target", async () => {
    const source =
      createProviderProvisioningSource(unreadableOptions<ProviderProvisioningSourceOptions>());
    const target =
      createProviderProvisioningTarget(unreadableOptions<ProviderProvisioningTargetOptions>());
    await expect(source.read("sync-test")).rejects.toMatchObject({
      code: "zhiliu_managed_models_only",
    });
    await expect(Reflect.apply(target.apply, target, [{}])).rejects.toMatchObject({
      code: "zhiliu_managed_models_only",
    });
  });

  it.each([undefined, "plugin", "mcp-status"])(
    "在命令解析/env/provider admission 之前关闭 %s CLI lane，包括只读控制面",
    async (lane) => {
      const commandResolver = vi.fn(() => ({
        command: process.execPath,
        args: ["-e", "throw new Error('must not spawn')"],
      }));
      const resolveSpawnEnv = vi.fn(() => ({ OPENAI_API_KEY: "must-not-load" }));
      const waitForSpawnAdmission = vi.fn();
      const manager = new ZCodeAgentProcessManager({
        lane,
        commandResolver,
        resolveSpawnEnv,
        waitForSpawnAdmission,
      });
      try {
        await expect(manager.getClient({ workspacePath: process.cwd() })).rejects.toMatchObject({
          code: "zhiliu_desktop_inference_unavailable",
        });
        expect(commandResolver).not.toHaveBeenCalled();
        expect(resolveSpawnEnv).not.toHaveBeenCalled();
        expect(waitForSpawnAdmission).not.toHaveBeenCalled();
      } finally {
        await manager.disposeAllAndWait();
      }
    },
  );
});
