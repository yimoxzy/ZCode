import { z } from "zod";

export const zhiliuHostCredentialSchema = z
  .object({
    host_token: z.string().min(20).max(512),
    device_id: z.string().uuid(),
    user_id: z.string().uuid(),
    space_id: z.string().uuid(),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ZhiliuHostCredential = z.infer<typeof zhiliuHostCredentialSchema>;

export const zhiliuToolRequestSchema = z
  .object({
    id: z.string().uuid(),
    device_id: z.string().uuid(),
    user_id: z.string().uuid(),
    space_id: z.string().uuid(),
    nonce: z.string().min(16).max(128),
    tool: z.enum(["file_read", "file_write", "terminal_exec"]),
    arguments: z.record(z.string(), z.unknown()),
    status: z.string().max(20),
    expires_at: z.string().datetime({ offset: true }),
  })
  .passthrough();
export type ZhiliuToolRequest = z.infer<typeof zhiliuToolRequestSchema>;

export const zhiliuToolPortCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start"),
      origin: z.string().url(),
      credential: zhiliuHostCredentialSchema,
      privateKey: z.string().max(2048),
      stateDirectory: z.string().min(1).max(4096),
      workspacePath: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("answer"),
      id: z.string().uuid(),
      answer: z.enum(["approve", "reject", "content", "summary"]),
    })
    .strict(),
  z.object({ type: z.literal("stop") }).strict(),
]);
export type ZhiliuToolPortCommand = z.infer<typeof zhiliuToolPortCommandSchema>;

export const zhiliuToolPortEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("review"),
      id: z.string().uuid(),
      title: z.string().max(200),
      detail: z.string().max(80000),
      kind: z.enum(["operation", "result"]),
    })
    .strict(),
  z
    .object({ type: z.literal("status"), connected: z.boolean(), message: z.string().max(200) })
    .strict(),
]);
export type ZhiliuToolPortEvent = z.infer<typeof zhiliuToolPortEventSchema>;
