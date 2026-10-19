import type { ComponentProps } from "react";
import { ZHILIU_DESKTOP_ENABLED } from "@zcode/shared";
import { FeedbackCenter } from "@/feedback/FeedbackCenter.js";

export function FeedbackHost(props: ComponentProps<typeof FeedbackCenter>) {
  // 上游工单支持无账号提交；仅阻止 OAuth 或桌面命令无法阻止后台日志上传。
  if (ZHILIU_DESKTOP_ENABLED) return null;
  return <FeedbackCenter {...props} />;
}
