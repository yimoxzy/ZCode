import { ZHILIU_DESKTOP_ENABLED } from "@zcode/shared";
import upstreamLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import zhiliuLogoUrl from "@/assets/zhiliu/logo.svg";

export const applicationLogoUrl = ZHILIU_DESKTOP_ENABLED ? zhiliuLogoUrl : upstreamLogoUrl;
export const applicationName = ZHILIU_DESKTOP_ENABLED ? "织流" : "ZCode";
export const applicationAvatarFallback = ZHILIU_DESKTOP_ENABLED ? "织" : "Z";
