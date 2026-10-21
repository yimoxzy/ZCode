import { useEffect } from "react";
import type { ZhiliuManagedDraftSelectionInput } from "./contract.js";

const MANAGED_ALIAS = "zhiliu-managed";

/** Reuse the Composer owner; never infer a reasoning value from a product tier name. */
export function useZhiliuManagedDraftSelection({
  enabled,
  modelSelectionState,
  draftSelection,
  onSelectModel,
}: ZhiliuManagedDraftSelectionInput): void {
  useEffect(() => {
    if (
      !enabled ||
      modelSelectionState.status !== "ready" ||
      modelSelectionState.refreshError ||
      draftSelection?.providerId !== MANAGED_ALIAS ||
      draftSelection.modelId !== MANAGED_ALIAS
    )
      return;
    const model = modelSelectionState.view.providers
      .find((provider) => provider.providerId === MANAGED_ALIAS)
      ?.models.find((candidate) => candidate.modelId === MANAGED_ALIAS);
    const levels = model?.config.optionSpecs.reasoningLevel.values;
    if (!levels || levels.length !== 1) return;
    const reasoningLevel = levels[0];
    if (!reasoningLevel || reasoningLevel === draftSelection.options?.reasoningLevel) return;
    // 实机证据：Main 已切 low，旧 medium 草稿仍被严格提交校验拒绝。
    // 只消费当前 Host 的单值授权并走原草稿回调，不能放宽校验或改写已接受任务。
    onSelectModel(
      MANAGED_ALIAS,
      MANAGED_ALIAS,
      { provider: MANAGED_ALIAS, model: MANAGED_ALIAS },
      reasoningLevel,
    );
  }, [enabled, modelSelectionState, draftSelection, onSelectModel]);
}
