import { LogIn, LogOut, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZhiliuAccount } from "@/hooks/useZhiliuAccount.js";

export function ZhiliuAccountControls() {
  const { locale } = useZCodeIntl();
  const { account, busy, failed, login, logout, cancel } = useZhiliuAccount();
  const chinese = locale === "zh-CN";
  const pending = account.phase === "authorizing";
  const authenticated = account.phase === "authenticated";
  return (
    <div
      className="flex min-w-0 items-center gap-2 [app-region:no-drag]"
      data-testid="zhiliu-account-controls"
    >
      {authenticated && (
        <span
          className="max-w-44 truncate text-ui-caption text-foreground-subtle"
          title={`${account.user?.email ?? ""} · ${account.space?.name ?? ""}`}
        >
          {account.user?.nickname || account.user?.email || (chinese ? "已登录" : "Signed in")}
          {account.space?.name ? ` · ${account.space.name}` : ""}
        </span>
      )}
      {pending ? (
        <>
          <span role="status" className="text-ui-caption text-foreground-subtle">
            {chinese ? "请在浏览器确认登录" : "Confirm sign-in in your browser"}
            {account.userCode ? ` · ${account.userCode}` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            <X />
            {chinese ? "取消登录" : "Cancel sign-in"}
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void (authenticated ? logout() : login())}
        >
          {authenticated ? <LogOut /> : <LogIn />}
          {authenticated
            ? chinese
              ? "退出登录"
              : "Sign out"
            : chinese
              ? "登录织流"
              : "Sign in to Zhiliu"}
        </Button>
      )}
      {account.phase === "unavailable" && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void logout()}>
          <LogOut />
          {chinese ? "退出登录" : "Sign out"}
        </Button>
      )}
      {(failed || account.phase === "unavailable") && (
        <span role="alert" className="text-ui-caption text-destructive">
          {chinese ? "账号连接未完成，请重试" : "Account connection unavailable. Please retry."}
        </span>
      )}
    </div>
  );
}
