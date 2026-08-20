import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { staffLandingPath, sectionForPath, STAFF_NO_ACCESS_PATH } from "@/lib/onboardingRoute";

/** Gate admin-only routes (sits inside the already-authenticated AppLayout).
 *  Allows both ADMIN and STAFF users into the admin area. Per-section
 *  permission checks are enforced by the backend + sidebar filtering. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  // Subscribe to the whole user so a live permission change (via the background
  // sync) re-evaluates this guard — e.g. an admin clearing/unassigning the role
  // must immediately move the staff member off a now-forbidden panel.
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const role = user?.role;

  if (role !== "ADMIN" && role !== "STAFF") {
    return <Navigate to="/dashboard" replace />;
  }

  // STAFF must only ever sit on a section their role *currently* grants. When an
  // admin edits their role live, the background permission sync updates
  // `user.permissions` and this guard re-runs — so we re-check the current page
  // here rather than leave a stale, now-forbidden panel on screen.
  if (role === "STAFF" && location.pathname !== STAFF_NO_ACCESS_PATH) {
    const permissions = user?.permissions ?? [];
    const landing = staffLandingPath(permissions);

    // No permitted section at all (permissions cleared, or role unassigned) →
    // the friendly "no access yet" screen.
    if (landing === STAFF_NO_ACCESS_PATH) {
      return <Navigate to={STAFF_NO_ACCESS_PATH} replace />;
    }

    // On a section they no longer hold — e.g. "Plans" was just removed while they
    // were viewing it, or an ADMIN-only page (sectionForPath → null) was reached
    // by URL. Bounce them to their first permitted section (the landing path)
    // instead of showing the panel they can no longer access.
    const section = sectionForPath(location.pathname);
    const holdsSection =
      section !== null && permissions.some((p) => p.startsWith(`${section}.`));
    if (!holdsSection && landing !== location.pathname) {
      return <Navigate to={landing} replace />;
    }
  }

  return <>{children}</>;
}
