import { ZCodeAppLogo } from "@zcode/ui/app-logo";
import { ZHILIU_DESKTOP_ENABLED } from "@zcode/shared";
import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";

/** 连接前各页复用桌面图标及编译期品牌，不从账号或 URL 推导产品身份。 */
export function WebRemoteControlBrand({
  className,
  locale = "zh-CN",
}: {
  className?: string;
  locale?: WebRemoteControlScreenLocale;
}) {
  return (
    <span className={["inline-flex items-center gap-2", className].filter(Boolean).join(" ")}>
      <ZCodeAppLogo className="size-5" />
      <span className="text-ui-xs font-medium">
        {ZHILIU_DESKTOP_ENABLED ? (locale === "zh-CN" ? "织流" : "Zhiliu") : "ZCode"}
      </span>
    </span>
  );
}
