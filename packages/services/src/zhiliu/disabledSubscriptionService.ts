import { createDynamicWorkflowClientConfig } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscription.js";
import { rejectOfficialCloudOperation } from "./officialCloudPolicy.js";

/** 不装配官方 provider，不读取凭据，不把上游套餐映射为织流套餐。 */
export function createDisabledSubscriptionService(): ICodingPlanSubscriptionService {
  return {
    getStaticProducts: async () => ({}),
    getStaticTeamProducts: async () => ({}),
    getStartPlanPreview: async () => null,
    getManualClaimPlanPreviews: async () => ({ plans: [] }),
    getOffPeakClientConfig: async () => ({
      enabled: false,
      modelSelectionView: { revision: 0, providers: [] },
    }),
    getDynamicWorkflowClientConfig: async () =>
      createDynamicWorkflowClientConfig("disabled", "default"),
    getModelContextBudgetStrategy: async () => "preflight-v1",
    getBillingDiscount: async () => undefined,
    getRequestVerificationConfig: async () => null,
    getForceUpdateConfig: async () => null,
    getEnterprisePricing: async () => ({ productList: [] }),
    queryStripeCards: async () => [],
    getEnterprisePendingOrders: async () => [],
    batchPreview: rejectOfficialCloudOperation,
    claimManualPlan: rejectOfficialCloudOperation,
    productInfo: rejectOfficialCloudOperation,
    preview: rejectOfficialCloudOperation,
    createSign: rejectOfficialCloudOperation,
    updateSign: rejectOfficialCloudOperation,
    checkPayment: rejectOfficialCloudOperation,
    checkPendingOrders: rejectOfficialCloudOperation,
    bindStripeCard: rejectOfficialCloudOperation,
    unbindStripeCard: rejectOfficialCloudOperation,
    payStripe: rejectOfficialCloudOperation,
    checkPaypalSupport: rejectOfficialCloudOperation,
    createPaypalSetupToken: rejectOfficialCloudOperation,
    subscribePaypal: rejectOfficialCloudOperation,
    getEnterpriseBalance: rejectOfficialCloudOperation,
    calculateEnterpriseOrder: rejectOfficialCloudOperation,
    createEnterpriseOrder: rejectOfficialCloudOperation,
    cancelEnterpriseOrder: rejectOfficialCloudOperation,
    continueEnterpriseOrderPayment: rejectOfficialCloudOperation,
    checkEnterpriseOrderStatus: rejectOfficialCloudOperation,
  };
}
