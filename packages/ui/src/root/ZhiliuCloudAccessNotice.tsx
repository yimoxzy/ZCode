import { Cloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenZhiliuCloud } from "@/hooks/useOpenZhiliuCloud.js";

/** 本地 Agent 尚未开放，保留项目界面并指向真实可用的云授权入口。 */
export function ZhiliuCloudAccessNotice() {
  const { locale } = useZCodeIntl();
  const { openCloud, opening, failed } = useOpenZhiliuCloud();
  const chinese = locale === "zh-CN";
  return (
    <section
      data-testid="zhiliu-cloud-access-notice"
      className="m-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {chinese ? "在云 Agent 中继续" : "Continue with Cloud Agents"}
        </p>
        <p className="mt-1 text-ui-caption text-foreground-subtle">
          {chinese
            ? "本地 Agent 将在平台授权接入后开放，请先登录云 Agent。"
            : "Local Agents will be available after platform authorization is connected. Sign in to Cloud Agents to continue."}
        </p>
        {failed && (
          <p role="alert" className="mt-1 text-ui-caption text-destructive">
            {chinese ? "云工作台未能打开，请重试" : "Could not open Cloud. Please retry."}
          </p>
        )}
      </div>
      <Button disabled={opening} onClick={() => void openCloud()}>
        <Cloud />
        {chinese ? "登录云 Agent" : "Sign in to Cloud Agents"}
      </Button>
    </section>
  );
}
