import { Cloud, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenZhiliuCloud } from "@/hooks/useOpenZhiliuCloud.js";

/** 导航条占用正常布局；云账号保留在独立工作台，不读取本地 OAuth 凭据。 */
export function ZhiliuWorkspaceSwitcher({ onOpenLocal }: { onOpenLocal: () => void }) {
  const { locale } = useZCodeIntl();
  const { openCloud, opening, failed } = useOpenZhiliuCloud();
  const chinese = locale === "zh-CN";

  return (
    <nav
      aria-label={chinese ? "工作模式" : "Workspace mode"}
      data-testid="zhiliu-workspace-switcher"
      className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-3 py-1.5 text-ui-base text-foreground platform-macos-desktop:pl-20 platform-windows-desktop:pr-36 platform-linux-desktop:pr-36 [app-region:drag]"
    >
      <span className="mr-1 font-medium">{chinese ? "织流" : "Zhiliu"}</span>
      <Button
        variant="outline"
        size="sm"
        className="[app-region:no-drag]"
        disabled={opening}
        onClick={() => void openCloud()}
        data-testid="zhiliu-open-cloud"
      >
        <Cloud />
        {chinese ? "云 Agent" : "Cloud Agents"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        aria-current="page"
        className="[app-region:no-drag]"
        onClick={onOpenLocal}
        data-testid="zhiliu-open-local"
      >
        <FolderOpen />
        {chinese ? "本地项目" : "Local projects"}
      </Button>
      <span className="hidden min-w-0 truncate text-ui-caption text-foreground-subtle lg:block">
        {chinese
          ? "登录织流 · 模型由平台统一管理"
          : "Sign in to Zhiliu · Models managed by your platform"}
      </span>
      {failed && (
        <span role="alert" className="min-w-0 truncate text-ui-caption text-destructive">
          {chinese ? "云工作台未能打开，请重试" : "Could not open Cloud. Please retry."}
        </span>
      )}
    </nav>
  );
}
