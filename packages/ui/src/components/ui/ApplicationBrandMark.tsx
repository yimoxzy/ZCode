import { cn } from "@/components/lib/utils.js";
import { applicationLogoUrl, applicationName } from "@/lib/applicationBrand.js";

/** 应用身份与供应商标识分开，避免把模型供应商图标当成客户端品牌。 */
export function ApplicationBrandMark({ className }: { className?: string }) {
  return (
    <img
      src={applicationLogoUrl}
      alt={applicationName}
      className={cn("shrink-0 select-none", className)}
      draggable={false}
    />
  );
}
