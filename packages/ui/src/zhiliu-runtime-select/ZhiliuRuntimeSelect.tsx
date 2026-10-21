import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import {
  DesktopCommandIds,
  zhiliuRuntimeSelectionViewSchema,
  type ZhiliuRuntimeSelection,
  type ZhiliuRuntimeSelectionView,
} from "@zcode/shared";
import type { ZhiliuRuntimeSelectProps } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";

/** Business selections only. Native Main owns catalog authorization and workspace teardown. */
export function ZhiliuRuntimeSelect({
  workspacePath,
  workspaceIdentity,
  disabled,
}: ZhiliuRuntimeSelectProps) {
  const platform = usePlatform();
  const [view, setView] = useState<ZhiliuRuntimeSelectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const epoch = useRef(0);
  const target = { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
  useEffect(() => {
    epoch.current++;
    setView(null);
    setFailed(false);
    setBusy(false);
    setWaiting(false);
    return () => {
      epoch.current++;
    };
  }, [workspacePath, workspaceIdentity]);
  const request = async (selection?: ZhiliuRuntimeSelection) => {
    const current = ++epoch.current;
    setBusy(true);
    setFailed(false);
    setWaiting(false);
    try {
      const value = await platform.executeDesktopCommand(
        selection
          ? DesktopCommandIds.SetZhiliuRuntimeSelection
          : DesktopCommandIds.GetZhiliuRuntimeSelection,
        selection ? { ...target, selection } : target,
      );
      const next = zhiliuRuntimeSelectionViewSchema.parse(value);
      if (current === epoch.current) setView(next);
    } catch (error) {
      if (current === epoch.current) {
        setFailed(true);
        setWaiting(
          error instanceof Error &&
            error.message.includes("请等待本地任务结束后切换Agent或思考档位"),
        );
      }
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const agent =
    view?.catalog.agents.find((item) => item.id === view.selection.agent_id)?.name ?? "通用对话";
  const tier =
    view?.catalog.inference_profiles.find((item) => item.id === view.selection.inference_profile_id)
      ?.name ?? "默认思考";
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !busy) void request();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-64 gap-1 px-2 text-ui-sm"
          disabled={disabled || busy}
          data-testid="zhiliu-runtime-select"
          title={disabled ? "任务结束后可切换当前项目的Agent与思考档位" : `${agent} · ${tier}`}
        >
          {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
          <span className="truncate">
            {agent} · {tier}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-h-96 w-72 overflow-y-auto">
        {failed ? (
          <div role="alert" className="px-2 py-2 text-ui-caption text-destructive">
            {waiting
              ? "请等待本地任务结束后切换Agent或思考档位"
              : "暂时无法读取平台配置，请确认已登录后重试"}
          </div>
        ) : null}
        {view ? (
          <>
            <DropdownMenuLabel>当前项目的 Agent</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={view.selection.agent_id ?? "__default"}
              onValueChange={(value) =>
                void request({ ...view.selection, agent_id: value === "__default" ? null : value })
              }
            >
              <DropdownMenuRadioItem value="__default" disabled={busy}>
                通用对话
              </DropdownMenuRadioItem>
              {view.catalog.agents.map((item) => (
                <DropdownMenuRadioItem
                  key={item.id}
                  value={item.id}
                  disabled={busy}
                  title={item.description}
                >
                  {item.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>思考档位</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={view.selection.inference_profile_id ?? "__default"}
              onValueChange={(value) =>
                void request({
                  ...view.selection,
                  inference_profile_id: value === "__default" ? null : value,
                })
              }
            >
              <DropdownMenuRadioItem value="__default" disabled={busy}>
                默认思考
              </DropdownMenuRadioItem>
              {view.catalog.inference_profiles.map((item) => (
                <DropdownMenuRadioItem
                  key={item.id}
                  value={item.id}
                  disabled={busy}
                  title={item.description}
                >
                  {item.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : (
          <div className="px-2 py-2 text-ui-caption text-foreground-subtle">
            {busy ? "正在读取平台配置…" : "登录织流后选择平台已发布的Agent与思考档位"}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
