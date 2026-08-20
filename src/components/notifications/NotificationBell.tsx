import { useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  PhoneMissed,
  UserCheck,
  CreditCard,
  BrainCircuit,
  Info,
  CheckCheck,
  Trash2,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import {
  useNotificationStore,
  type NotificationType,
} from "@/stores/useNotificationStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ⌥N on macOS, Alt+N elsewhere — matches the global notifications shortcut.
const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const NOTIF_SHORTCUT = isMac ? "⌥N" : "Alt+N";

const TYPE_ICON: Record<NotificationType, typeof Bell> = {
  missed_call: PhoneMissed,
  new_lead: UserCheck,
  billing: CreditCard,
  agent: BrainCircuit,
  system: Info,
};

const TYPE_COLOR: Record<NotificationType, string> = {
  missed_call: "text-danger",
  new_lead: "text-success",
  billing: "text-warning",
  agent: "text-primary",
  system: "text-muted-foreground",
};

export function NotificationBell() {
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const setPanelOpen = useNotificationStore((s) => s.setPanelOpen);
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!panelOpen) return;
    function handleClick(e: MouseEvent) {
      const root = panelRef.current;
      // The mobile and desktop bells are both always mounted (one is CSS-hidden).
      // Ignore the hidden instance, otherwise it treats clicks inside the visible
      // panel as "outside" and closes it on mousedown — before buttons can fire.
      if (!root || root.getClientRects().length === 0) return;
      if (!root.contains(e.target as Node)) setPanelOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [panelOpen, setPanelOpen]);

  return (
    <div className="relative" ref={panelRef}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Notifications"
          >
            <Bell className="size-5" />
            {unreadCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-4.5 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex items-center gap-1.5">
          Notifications
          <kbd className="rounded border border-background/30 px-1 py-px text-[10px] font-medium">
            {NOTIF_SHORTCUT}
          </kbd>
        </TooltipContent>
      </Tooltip>

      {panelOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-panel)] sm:w-96">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Notifications</h3>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <CheckCheck className="size-3" /> Mark all read
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Trash2 className="size-3" /> Clear
                </button>
              )}
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Bell className="size-8 text-muted-foreground/40" />
                <p className="mt-2 text-sm text-muted-foreground">No notifications yet</p>
              </div>
            ) : (
              notifications.map((n) => {
                const Icon = TYPE_ICON[n.type];
                return (
                  <button
                    key={n.id}
                    onClick={() => {
                      markRead(n.id);
                      setPanelOpen(false);
                      if (n.link) navigate(n.link);
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                      !n.read && "bg-primary-tint-soft",
                    )}
                  >
                    <span className={cn("mt-0.5 shrink-0", TYPE_COLOR[n.type])}>
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm", !n.read && "font-medium")}>{n.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{n.message}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground/70">{timeAgo(n.createdAt)}</p>
                    </div>
                    {!n.read && (
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
