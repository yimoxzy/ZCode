import { z } from "zod";

export const relayPrincipalSchema = z
  .object({
    protocol_version: z.literal(1),
    principal_id: z.string().min(1).max(200),
    user_id: z.string().uuid(),
    space_id: z.string().uuid(),
    desktop_device_id: z.string().uuid().nullable(),
    role: z.enum(["device", "terminal"]),
    device_mid: z.string().min(1).max(128).nullable(),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.principal_id !== `${value.user_id}:${value.space_id}`)
      ctx.addIssue({ code: "custom", message: "relay principal scope mismatch" });
    if (
      value.role === "device" &&
      (!value.desktop_device_id || value.device_mid !== value.desktop_device_id)
    )
      ctx.addIssue({ code: "custom", message: "relay device binding required" });
  });
export type RelayPrincipal = z.infer<typeof relayPrincipalSchema>;
export interface RelayOptions {
  /** 私有SaaS内省；实现必须实时验证根授权、设备和空间成员。 */
  introspect(relayGrant: string): Promise<RelayPrincipal>;
  host?: string;
  port?: number;
  publicOrigin: string;
  now?: () => number;
  revalidateIntervalMs?: number;
}
export interface RelayHandle {
  httpUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}
