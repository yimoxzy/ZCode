import { useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

type ZhiliuEntryCommand =
  | typeof DesktopCommandIds.OpenZhiliuCloud
  | typeof DesktopCommandIds.OpenFeedback
  | typeof DesktopCommandIds.ConnectZhiliuComputer;

/** 云登录只由 Main 打开固定服务窗口；不把网页授权复制到本地模型配置。 */
export function useOpenZhiliuCloud() {
  const platform = usePlatform();
  const [opening, setOpening] = useState(false);
  const [failedCommand, setFailedCommand] = useState<ZhiliuEntryCommand | null>(null);
  const open = async (command: ZhiliuEntryCommand) => {
    if (opening) return;
    setOpening(true);
    setFailedCommand(null);
    try {
      const result = await platform.executeDesktopCommand(command);
      if (typeof result === "object" && result !== null && "opened" in result) {
        setFailedCommand(result.opened === false ? command : null);
      }
    } catch {
      // 原生异常可能包含授权参数；界面只记录命令，不复制设备凭据。
      logger.warn("[zhiliu] 无法完成工作台操作", { command });
      setFailedCommand(command);
    } finally {
      setOpening(false);
    }
  };
  return {
    openCloud: () => open(DesktopCommandIds.OpenZhiliuCloud),
    openFeedback: () => open(DesktopCommandIds.OpenFeedback),
    connectComputer: () => open(DesktopCommandIds.ConnectZhiliuComputer),
    opening,
    failed: failedCommand !== null,
    connectionFailed: failedCommand === DesktopCommandIds.ConnectZhiliuComputer,
  };
}
