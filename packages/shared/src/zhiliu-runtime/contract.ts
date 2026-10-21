import { z } from "zod";

/** 仅由可信 Host 写入 CLI stdin 首行；不是 Renderer/RPC 可变设置。 */
export const zhiliuManagedRuntimeProfileSchema = z
  .object({
    version: z.literal(1),
    gatewayBaseUrl: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "http:" && url.hostname === "127.0.0.1" &&
        url.port !== "" && url.pathname === "/v1" && !url.username && !url.password &&
        !url.search && !url.hash;
    }, "托管运行时只允许本机 broker"),
    capabilityToken: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
    modelId: z.literal("zhiliu-managed"),
    protocol: z.enum(["responses", "chat_completions"]),
    maxContextTokens: z.number().int().positive().max(10000000),
    maxOutputTokens: z.number().int().positive().max(10000000),
    reasoningEffort: z.string().min(1).max(40).nullable().optional(),
    instructions: z.string().max(200000).optional(),
    pluginManifest: z.object({ roots: z.array(z.string().min(1).max(4096)).max(100) }).strict().optional(),
    toolAllowlist: z.array(z.string().min(1).max(200)).max(500).optional(),
    /** Host authority: availability never means consent to these platform writes. */
    approvalRequiredTools: z.array(z.string().regex(/^mcp__zhiliu_platform__[A-Za-z0-9_-]+$/u)).max(500)
      .refine(names => new Set(names).size === names.length, "单次审批工具不能重复").optional(),
    platformTools: z.object({
      url: z.string().url().refine(value => {
        const url = new URL(value);
        return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" &&
          url.pathname === "/mcp" && !url.username && !url.password && !url.search && !url.hash;
      }, "平台工具只允许本机 broker"),
      capabilityToken: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
      timeoutMs: z.number().int().positive().max(1800000).optional(),
    }).strict().optional(),
  })
  .strict().refine(profile => !profile.platformTools || profile.platformTools.capabilityToken !== profile.capabilityToken,
    "模型与工具 capability 必须独立")
  .refine(profile => !profile.toolAllowlist || (profile.approvalRequiredTools ?? []).every(name => profile.toolAllowlist!.includes(name)),
    "单次审批工具必须属于已批准工具清单");
export type ZhiliuManagedRuntimeProfile = z.infer<typeof zhiliuManagedRuntimeProfileSchema>;
