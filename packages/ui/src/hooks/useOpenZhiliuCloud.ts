import { useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

/** 云登录只由 Main 打开固定服务窗口；不把网页授权复制到本地模型配置。 */
export function useOpenZhiliuCloud() {
  const platform = usePlatform();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async (
    command: typeof DesktopCommandIds.OpenZhiliuCloud | typeof DesktopCommandIds.OpenFeedback,
  ) => {
    if (opening) return;
    setOpening(true);
    setFailed(false);
    try {
      const result = await platform.executeDesktopCommand(command);
      if (typeof result === "object" && result !== null && "opened" in result) {
        setFailed(result.opened === false);
      }
    } catch (error) {
      logger.warn("[zhiliu] 无法打开云工作台", { error });
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };
  return {
    openCloud: () => open(DesktopCommandIds.OpenZhiliuCloud),
    openFeedback: () => open(DesktopCommandIds.OpenFeedback),
    opening,
    failed,
  };
}
