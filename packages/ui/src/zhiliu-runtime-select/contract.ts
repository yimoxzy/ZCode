import type { ZhiliuRuntimeWorkspace } from "@zcode/shared";
import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
/** Presentation only; Main owns account, grant, effective selection, and runtime invalidation. */
export interface ZhiliuRuntimeSelectProps extends ZhiliuRuntimeWorkspace {
  disabled: boolean;
  /** Re-read this workspace's Host catalogue only after Main accepts a selection. */
  onSelectionChanged?: () => void;
}

/** Renderer intent only; the ready Host catalogue remains the authorization source. */
export interface ZhiliuManagedDraftSelectionInput {
  enabled: boolean;
  modelSelectionState: ModelSelectionState;
  draftSelection: ModelSelection | undefined;
  onSelectModel: (
    provider: string,
    model: string,
    source: { provider: string; model: string } | null,
    reasoningLevel?: string,
  ) => void;
}
