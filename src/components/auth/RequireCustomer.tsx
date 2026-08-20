import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { staffLandingPath } from "@/lib/onboardingRoute";

/** Gate customer-facing routes (Dashboard, Call Inbox, AI Brain, Connect CRM,
 *  Plans). STAFF are admin-team members with no customer profile, so these pages
 *  would hang on a perpetual loading skeleton (they gate on `profile.id`, which
 *  a staff account never has). Redirect them to their admin landing instead.
 *  ADMIN and USER pass through — both have a real profile. */
export function RequireCustomer({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (user?.role === "STAFF") {
    return <Navigate to={staffLandingPath(user.permissions ?? [])} replace />;
  }
  return <>{children}</>;
}
