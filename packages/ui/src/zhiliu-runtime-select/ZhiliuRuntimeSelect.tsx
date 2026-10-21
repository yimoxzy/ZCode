import { useCallback, useEffect, useRef, useState } from "react";
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
import { ComposerEffortSlider } from "@/chat-input-toolbar/ComposerModelMenu.js";

const DEFAULT_PROFILE = "__default";

/** Business selections only. Native Main owns catalog authorization and workspace teardown. */
export function ZhiliuRuntimeSelect({
  workspacePath,
  workspaceIdentity,
  disabled,
  onSelectionChanged,
}: ZhiliuRuntimeSelectProps) {
  const platform = usePlatform();
  const [projection, setProjection] = useState<{
    targetKey: string;
    view: ZhiliuRuntimeSelectionView;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const epoch = useRef(0);
  const ownerKey = workspaceIdentity?.trim() || workspacePath;
  const targetKey = `${ownerKey}\0${workspacePath}`;
  const owner = useRef(targetKey);
  owner.current = targetKey;
  const inFlight = useRef(false);
  const mutationDisabled = useRef(disabled);
  mutationDisabled.current = disabled;
  const changed = useRef(onSelectionChanged);
  changed.current = onSelectionChanged;
  const view = projection?.targetKey === targetKey ? projection.view : null;
  const request = useCallback(
    async (selection?: ZhiliuRuntimeSelection) => {
      // 运行中仍可只读恢复标题；disabled 只限制修改 Main 的选择。
      if (inFlight.current || (selection && mutationDisabled.current)) return;
      const current = ++epoch.current;
      const isCurrent = () => current === epoch.current && owner.current === targetKey;
      inFlight.current = true;
      setBusy(true);
      setFailed(false);
      setWaiting(false);
      try {
        const value = await platform.executeDesktopCommand(
          selection
            ? DesktopCommandIds.SetZhiliuRuntimeSelection
            : DesktopCommandIds.GetZhiliuRuntimeSelection,
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(selection ? { selection } : {}),
          },
        );
        const next = zhiliuRuntimeSelectionViewSchema.parse(value);
        if (isCurrent()) {
          setProjection({ targetKey, view: next });
          if (selection) changed.current?.();
        }
      } catch (error) {
        if (isCurrent()) {
          setFailed(true);
          setWaiting(
            error instanceof Error &&
              error.message.includes("请等待本地任务结束后切换Agent或思考档位"),
          );
        }
      } finally {
        if (isCurrent()) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [platform, targetKey, workspacePath, workspaceIdentity],
  );
  useEffect(() => {
    const reload = () => {
      // 实机 A/B 项目切回只清空 view 会永久显示默认档。只读恢复 Main 投影，
      // 不写草稿或触发 Host reload；账号换代和迟到回执共用同一代次屏障。
      epoch.current++;
      inFlight.current = false;
      setProjection(null);
      setFailed(false);
      setWaiting(false);
      void request();
    };
    reload();
    window.addEventListener("zhiliu-account-changed", reload);
    return () => {
      epoch.current++;
      inFlight.current = false;
      window.removeEventListener("zhiliu-account-changed", reload);
    };
  }, [request]);
  const agent =
    view?.catalog.agents.find((item) => item.id === view.selection.agent_id)?.name ?? "通用对话";
  const tier = view?.selection.inference_profile_id
    ? (view.catalog.inference_profiles.find(
        (item) => item.id === view.selection.inference_profile_id,
      )?.name ?? "档位不可用")
    : "默认思考";
  const label = view ? `${agent} · ${tier}` : failed ? "配置读取失败，请重试" : "正在读取平台配置…";
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
          title={disabled ? "任务结束后可切换当前项目的Agent与思考档位" : label}
        >
          {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
          <span className="truncate">{label}</span>
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
            <ComposerEffortSlider
              label="思考档位"
              levels={[
                { value: DEFAULT_PROFILE, label: "默认思考" },
                ...view.catalog.inference_profiles.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
              value={view.selection.inference_profile_id ?? DEFAULT_PROFILE}
              disabled={disabled || busy}
              visualKey={`${targetKey}\0${view.selection.agent_id ?? "__default"}`}
              onValueChange={(value) => {
                // 只映射平台目录 UUID；默认 sentinel 不越过 Main 的 null 合同。
                if (
                  value !== DEFAULT_PROFILE &&
                  !view.catalog.inference_profiles.some((item) => item.id === value)
                )
                  return;
                void request({
                  ...view.selection,
                  inference_profile_id: value === DEFAULT_PROFILE ? null : value,
                });
              }}
            />
          </>
        ) : (
          <div className="px-2 py-2 text-ui-caption text-foreground-subtle">
            {busy ? "正在读取平台配置…" : "打开菜单可重试读取平台配置"}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
