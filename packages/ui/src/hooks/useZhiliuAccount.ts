import { useCallback, useEffect, useRef, useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { logger } from "@/logger.js";

const ACCOUNT_CHANGED_EVENT = "zhiliu-account-changed";

export interface ZhiliuAccountView {
  phase: "logged_out" | "authorizing" | "authenticated" | "unavailable";
  user?: { nickname?: string; email?: string };
  space?: { name?: string };
  userCode?: string;
  message?: string;
}
function readAccount(value: unknown): ZhiliuAccountView | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("phase" in value) ||
    !["logged_out", "authorizing", "authenticated", "unavailable"].includes(
      String(value.phase),
    )
  )
    return null;
  return value as ZhiliuAccountView;
}

/** Main owns identity; this hook keeps only its public display projection. */
export function useZhiliuAccount() {
  const platform = usePlatform();
  const [account, setAccount] = useState<ZhiliuAccountView>({
    phase: "logged_out",
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    try {
      const next = readAccount(
        await platform.executeDesktopCommand(
          DesktopCommandIds.GetZhiliuAccount,
        ),
      );
      if (mounted.current && current === epoch.current && next)
        setAccount(next);
    } catch {
      // A status read must not expose a credential-bearing native exception.
      if (mounted.current && current === epoch.current) setFailed(true);
    }
  }, [platform]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onAccountChanged = () => void refresh();
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    };
  }, [refresh]);
  const run = async (
    command:
      | typeof DesktopCommandIds.LoginZhiliu
      | typeof DesktopCommandIds.LogoutZhiliu
      | typeof DesktopCommandIds.CancelZhiliuLogin,
  ) => {
    const current = ++epoch.current;
    setFailed(false);
    setBusy(true);
    if (command === DesktopCommandIds.LoginZhiliu)
      setAccount({ phase: "authorizing" });
    try {
      const value = await platform.executeDesktopCommand(command);
      if (current !== epoch.current || !mounted.current) return;
      const next = readAccount(value);
      if (next) {
        setAccount(next);
        if (
          command === DesktopCommandIds.LoginZhiliu &&
          next.phase !== "authenticated"
        )
          setFailed(true);
      }
      await refresh();
    } catch {
      logger.warn("[zhiliu-account] 账号操作未完成", { command });
      if (current === epoch.current && mounted.current) {
        setFailed(true);
        await refresh();
      }
    } finally {
      if (current === epoch.current && mounted.current) setBusy(false);
      // 只广播失效信号；每个视图从 Main 重读公开投影，不通过 DOM 传播凭据或账号对象。
      window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
    }
  };
  return {
    account,
    busy,
    failed,
    login: () => run(DesktopCommandIds.LoginZhiliu),
    logout: () => run(DesktopCommandIds.LogoutZhiliu),
    cancel: () => run(DesktopCommandIds.CancelZhiliuLogin),
  };
}
