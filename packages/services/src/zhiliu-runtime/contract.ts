import { z } from "zod";
import type { ZhiliuManagedRuntimeProfile } from "@zcode/shared";

export const runtimeGrantSchema = z
  .object({
    protocol_version: z.literal(1),
    grant_id: z.string().uuid(),
    runtime_grant: z.string().regex(/^rg_[A-Za-z0-9_-]{20,512}$/u),
    expires_at: z.string().datetime({ offset: true }),
    gateway_base_url: z.literal("/api/runtime-gateway/v1"),
    profile: z
      .object({
        model: z.literal("zhiliu-managed"),
        display_name: z.string().min(1).max(200),
        protocol: z.enum(["responses", "chat_completions"]),
        max_context_tokens: z.number().int().positive().max(10000000),
        max_output_tokens: z.number().int().positive().max(10000000),
        reasoning_effort: z.string().min(1).max(40).nullable(),
        inference_profile_id: z.string().uuid().nullable(),
        platform_tools_write_enabled: z.boolean().optional(),
        agent: z
          .object({ version_id: z.string().nullable(), instructions: z.string() })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export type RuntimeGrant = z.infer<typeof runtimeGrantSchema>;
export interface OwnedRuntimeGrant {
  origin: string;
  grant: RuntimeGrant;
}
export interface ManagedRuntimeTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
}
export interface ZhiliuManagedRuntimeAuthority {
  resolve(target: ManagedRuntimeTarget): Promise<ZhiliuManagedRuntimeProfile>;
  readProfile(): ZhiliuManagedRuntimeProfile | undefined;
  onDidChange(listener: () => void): () => void;
  invalidate(): Promise<void>;
  invalidateWorkspace(workspaceIdentity: string): Promise<void>;
  dispose(): Promise<void>;
}
/** Electron Main/UtilityProcess 的私有 MessagePort。禁止转发给 Renderer。 */
export interface RuntimePrivatePort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}
export const runtimePortRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("grant"),
      id: z.string().uuid(),
      workspaceIdentity: z.string().regex(/^local:[a-f0-9]{64}$/u),
    })
    .strict(),
  z
    .object({ type: z.literal("revoke"), id: z.string().uuid(), grantId: z.string().uuid() })
    .strict(),
  z.object({ type: z.literal("invalidated"), id: z.string().uuid() }).strict(),
]);
export const runtimePortResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("grant"),
      id: z.string().uuid(),
      origin: z.string().url(),
      grant: runtimeGrantSchema,
    })
    .strict(),
  z.object({ type: z.literal("error"), id: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("invalidate"),
      id: z.string().uuid(),
      workspaceIdentity: z
        .string()
        .regex(/^local:[a-f0-9]{64}$/u)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("available"), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("revoked"), id: z.string().uuid() }).strict(),
]);
