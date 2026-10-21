import { Cloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenZhiliuCloud } from "@/hooks/useOpenZhiliuCloud.js";

/** 托管模型说明；本地与云端均通过织流账号授权。 */
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
          {chinese ? "使用织流托管模型" : "Use Zhiliu managed models"}
        </p>
        <p className="mt-1 text-ui-caption text-foreground-subtle">
          {chinese
            ? "登录织流账号后，可在本地项目使用平台模型；模型和计费由平台统一管理。"
            : "Sign in to Zhiliu to use platform models in local projects. Your platform manages models and billing."}
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
