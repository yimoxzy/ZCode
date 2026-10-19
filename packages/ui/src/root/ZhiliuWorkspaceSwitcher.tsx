import { Cloud, FolderOpen, Laptop, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenZhiliuCloud } from "@/hooks/useOpenZhiliuCloud.js";
import { ApplicationBrandMark } from "@/components/ui/ApplicationBrandMark.js";

/** 导航条占用正常布局；云账号保留在独立工作台，不读取本地 OAuth 凭据。 */
export function ZhiliuWorkspaceSwitcher({ onOpenLocal }: { onOpenLocal: () => void }) {
  const { locale } = useZCodeIntl();
  const { openCloud, openFeedback, connectComputer, opening, failed, connectionFailed } =
    useOpenZhiliuCloud();
  const chinese = locale === "zh-CN";

  return (
    <nav
      aria-label={chinese ? "工作模式" : "Workspace mode"}
      data-testid="zhiliu-workspace-switcher"
      className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-3 py-1.5 text-ui-base text-foreground platform-macos-desktop:pl-20 platform-windows-desktop:pr-36 platform-linux-desktop:pr-36 [app-region:drag]"
    >
      <ApplicationBrandMark className="size-5" />
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
      <Button
        variant="outline"
        size="sm"
        className="[app-region:no-drag]"
        disabled={opening}
        onClick={() => void connectComputer()}
        title={
          chinese
            ? "连接这台电脑，文件操作须在本机确认"
            : "Connect this computer. File operations require local approval."
        }
        data-testid="zhiliu-connect-computer"
      >
        <Laptop />
        {chinese ? "连接电脑" : "Connect computer"}
      </Button>
      <span className="hidden min-w-0 truncate text-ui-caption text-foreground-subtle lg:block">
        {chinese
          ? "登录织流 · 模型由平台统一管理"
          : "Sign in to Zhiliu · Models managed by your platform"}
      </span>
      {failed && (
        <span role="alert" className="min-w-0 truncate text-ui-caption text-destructive">
          {connectionFailed
            ? chinese
              ? "电脑连接未完成，请重试"
              : "Could not connect this computer. Please retry."
            : chinese
              ? "云工作台未能打开，请重试"
              : "Could not open Cloud. Please retry."}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto [app-region:no-drag]"
        disabled={opening}
        onClick={() => void openFeedback()}
        data-testid="zhiliu-open-feedback"
      >
        <MessageSquare />
        {chinese ? "问题反馈" : "Feedback"}
      </Button>
    </nav>
  );
}
