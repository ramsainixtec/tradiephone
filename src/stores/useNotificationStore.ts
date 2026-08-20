import { create } from "zustand";
import { toast } from "sonner";
import { api, type ApiNotification } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";
import { useCallsStore } from "@/stores/useCallsStore";

// Call notifications (handled + missed) are the only ones that deep-link here —
// used to detect a fresh call and live-refresh the Call Logs without a reload.
const CALLS_LINK = "/dashboard/calls";

// Skip toasting on the very first hydrate — the initial backlog isn't "new".
// Module-level so it survives the poll hook remounting on navigation.
let hydratedOnce = false;
// Cap toasts per poll so a burst that arrived between polls can't flood the screen.
const MAX_TOASTS_PER_POLL = 3;

export type NotificationType = "missed_call" | "new_lead" | "billing" | "agent" | "system";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  link?: string;
}

interface NotificationState {
  notifications: AppNotification[];
  unreadCount: number;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /** Pull the latest notifications + unread count from the backend. */
  hydrate: () => Promise<void>;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

function fromApi(n: ApiNotification): AppNotification {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    read: n.read,
    createdAt: n.createdAt,
    link: n.link ?? undefined,
  };
}

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  notifications: [],
  unreadCount: 0,
  panelOpen: false,
  setPanelOpen: (open) => set({ panelOpen: open }),
  hydrate: async () => {
    const mark = sessionMark();
    try {
      const { notifications, unreadCount } = await api.notifications.list();
      if (sessionChanged(mark)) return; // response belongs to a previous account
      const incoming = notifications.map(fromApi);
      // Surface anything that arrived since the last poll as a live toast (e.g. a
      // new signup landing under onboarding), so an admin doesn't have to open the
      // bell to notice it. Only after the first hydrate — the initial list isn't new.
      if (hydratedOnce) {
        const seen = new Set(get().notifications.map((n) => n.id));
        const fresh = incoming.filter((n) => !n.read && !seen.has(n.id));
        for (const n of fresh.slice(0, MAX_TOASTS_PER_POLL)) {
          // Purely informational — the notification bell in the header already
          // lists everything, so a toast action would just be a redundant click.
          toast(n.title, { description: n.message || undefined });
        }
        // A new call just landed (its notification links to the Call Logs) →
        // refresh the calls store so the row appears live, no manual reload.
        if (fresh.some((n) => n.link === CALLS_LINK)) {
          void useCallsStore.getState().hydrate();
        }
      }
      hydratedOnce = true;
      set({ notifications: incoming, unreadCount });
    } catch {
      /* leave the last good state on a transient failure */
    }
  },
  markRead: (id) => {
    const notifications = get().notifications.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    );
    set({ notifications, unreadCount: notifications.filter((n) => !n.read).length });
    void api.notifications.markRead(id).catch(() => {});
  },
  markAllRead: () => {
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }));
    void api.notifications.markAllRead().catch(() => {});
  },
  clearAll: () => {
    set({ notifications: [], unreadCount: 0 });
    void api.notifications.clear().catch(() => {});
  },
}));
