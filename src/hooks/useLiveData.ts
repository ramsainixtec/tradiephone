import { useEffect } from "react";
import { env } from "@/lib/env";
import { getToken } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveStore } from "@/stores/useLiveStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useNotificationStore } from "@/stores/useNotificationStore";

// How long to coalesce a burst of server events into a single refresh. A busy
// call or a flurry of admin activity fires several notifications back-to-back;
// we only want one re-fetch, not one per event.
const COALESCE_MS = 400;

// Fallback poll cadence — used ONLY while the SSE stream is not connected (e.g.
// a proxy that buffers, a dropped connection mid-reconnect). While the stream is
// healthy, an idle tab makes zero requests: updates are pushed, not polled.
const FALLBACK_POLL_MS = 30_000;

/**
 * The single live-refresh driver for the whole authenticated app. Mount once
 * (in {@link AppLayout}).
 *
 * Primary path is a Server-Sent Events stream: the API pushes a tiny "something
 * changed" event only when real activity happens (a call lands, a signup, an
 * approval), and we bump the global {@link useLiveStore} tick. Pages refresh
 * **their own** data by depending on {@link useLiveTick}, so we re-fetch only
 * what the current screen shows — and an idle tab is completely silent.
 *
 * A slow fallback poll runs only while the stream is disconnected, so the app
 * still self-heals if SSE can't establish (buffering proxy, network blip).
 */
export function useLiveData() {
  const status = useAuthStore((s) => s.status);
  // Identity, not just signed-in-ness. Entering/leaving a customer's panel swaps
  // the token while `status` stays "authed", so keying on status alone left the
  // stream authenticated as the PREVIOUS account — subscribed to the wrong
  // `user:` channel, so the panel you're looking at received no pushes and fell
  // back to the 30s poll. Re-running on the user id reconnects as whoever is
  // active now.
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    if (status !== "authed") return;

    let connected = false;
    let coalesceTimer: number | undefined;

    // Re-hydrate the always-mounted chrome + notifications, then tick every
    // live-aware page so it reloads its own data. Trial/profile only matter for
    // customer (USER) accounts — admins aren't trial-gated and don't show usage
    // in the chrome, so their idle pages stay lean.
    const doRefresh = () => {
      useLiveStore.getState().bump();
      void useNotificationStore.getState().hydrate();
      if (useAuthStore.getState().user?.role === "USER") {
        void useTrialStore.getState().hydrate();
        void useProfileStore.getState().hydrate();
      }
    };

    // Coalesce a burst of SSE events into one refresh.
    const scheduleRefresh = () => {
      if (coalesceTimer !== undefined) return;
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = undefined;
        doRefresh();
      }, COALESCE_MS);
    };

    // --- SSE stream -------------------------------------------------------
    const token = getToken();
    let es: EventSource | null = null;
    if (token) {
      es = new EventSource(
        `${env.apiUrl}/api/events/stream?token=${encodeURIComponent(token)}`,
      );
      es.onopen = () => {
        connected = true;
      };
      // Any pushed event (including the initial "connected") triggers a coalesced
      // refresh — the payload is only a type tag, the data is pulled by the pages.
      es.onmessage = () => scheduleRefresh();
      es.onerror = () => {
        // EventSource auto-reconnects; mark disconnected so the fallback covers
        // the gap until onopen fires again.
        connected = false;
      };
    }

    // --- Fallback poll (only while the stream is down) --------------------
    const fallbackId = window.setInterval(() => {
      if (!connected && document.visibilityState === "visible") doRefresh();
    }, FALLBACK_POLL_MS);

    // Returning to the tab always does one immediate refresh (cheap, expected),
    // regardless of stream state.
    const onFocus = () => {
      if (document.visibilityState === "visible") doRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      es?.close();
      window.clearInterval(fallbackId);
      if (coalesceTimer !== undefined) window.clearTimeout(coalesceTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [status, userId]);
}

/**
 * Subscribe to the global live tick. Add the returned value to a data-loading
 * effect's dependency array so the loader re-runs whenever real activity is
 * pushed from the server — refreshing only the data that page shows:
 *
 *   const liveTick = useLiveTick();
 *   useEffect(() => { void load(); }, [load, liveTick]);
 */
export function useLiveTick(): number {
  return useLiveStore((s) => s.tick);
}
