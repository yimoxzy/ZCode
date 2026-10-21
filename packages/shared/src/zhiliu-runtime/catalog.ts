import { z } from "zod";

const displayItem = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    description: z.string().max(4000),
  })
  .strict();
/** Public display data only: no model identifier, URL, key, or grant. */
export const zhiliuRuntimeCatalogSchema = z
  .object({
    protocol_version: z.literal(1),
    agents: z
      .array(displayItem.extend({ version_id: z.string().uuid().nullable() }).strict())
      .max(1000),
    inference_profiles: z.array(displayItem).max(1000),
  })
  .strict();
export const zhiliuRuntimeSelectionSchema = z
  .object({
    agent_id: z.string().uuid().nullable(),
    inference_profile_id: z.string().uuid().nullable(),
  })
  .strict();
export const zhiliuRuntimeWorkspaceSchema = z
  .object({
    workspacePath: z.string().min(1).max(8192),
    workspaceIdentity: z.string().min(1).max(8192).optional(),
  })
  .strict();
export const zhiliuRuntimeSelectionInputSchema = zhiliuRuntimeWorkspaceSchema
  .extend({
    selection: zhiliuRuntimeSelectionSchema,
  })
  .strict();
export const zhiliuRuntimeSelectionViewSchema = z
  .object({
    catalog: zhiliuRuntimeCatalogSchema,
    selection: zhiliuRuntimeSelectionSchema,
  })
  .strict();
export type ZhiliuRuntimeSelection = z.infer<typeof zhiliuRuntimeSelectionSchema>;
export type ZhiliuRuntimeWorkspace = z.infer<typeof zhiliuRuntimeWorkspaceSchema>;
export type ZhiliuRuntimeSelectionView = z.infer<typeof zhiliuRuntimeSelectionViewSchema>;
export const DEFAULT_ZHILIU_RUNTIME_SELECTION: ZhiliuRuntimeSelection = {
  agent_id: null,
  inference_profile_id: null,
};
