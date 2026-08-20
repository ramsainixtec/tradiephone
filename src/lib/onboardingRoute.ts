import type { AuthUser } from "@/lib/api";
import { cardWallActive } from "@/lib/cardWall";

/** Onboarding step the user resumes at for the pricing/subscribe screen. */
export const ONBOARDING_PRICING_STEP = 8;

/** Where a STAFF member with no permitted section is sent — a friendly
 *  "no access yet" screen (see StaffNoAccessPage). */
export const STAFF_NO_ACCESS_PATH = "/dashboard/no-access";

// Staff-assignable sections → their landing route, in priority order (the first
// one a staff member holds is where they land). Admin-only areas (staff, roles,
// reports, webhooks, health, settings) are intentionally absent — staff can't be
// granted them, so they can never land there.
const SECTION_ROUTES: Record<string, string> = {
  overview: "/dashboard/admin/overview",
  customers: "/dashboard/admin/customers",
  subscriptions: "/dashboard/admin/subscriptions",
  plans: "/dashboard/admin/plans",
  voice_bank: "/dashboard/admin/voice-bank",
  phone_numbers: "/dashboard/admin/phone-numbers",
  resellers: "/dashboard/admin/resellers",
  emails: "/dashboard/admin/emails",
  audit: "/dashboard/admin/audit",
};

export function staffLandingPath(permissions: string[]): string {
  for (const key of Object.keys(SECTION_ROUTES)) {
    if (permissions.some((p) => p.startsWith(`${key}.`))) return SECTION_ROUTES[key];
  }
  // No permitted section — a role with nothing ticked, or no role assigned yet.
  return STAFF_NO_ACCESS_PATH;
}

/**
 * Which staff-assignable section an admin pathname belongs to — e.g.
 * "/dashboard/admin/customers/123" → "customers". Returns null when the path
 * isn't a staff-assignable section (an ADMIN-only page like settings/roles, or
 * anything outside the admin area). Used to bounce a STAFF member off a panel
 * the moment their role loses that section.
 */
export function sectionForPath(pathname: string): string | null {
  for (const [key, route] of Object.entries(SECTION_ROUTES)) {
    if (pathname === route || pathname.startsWith(`${route}/`)) return key;
  }
  return null;
}

export function onboardingRedirectPath(user: AuthUser | null): string {
  // STAFF are admin-team members with no customer profile — route them to their
  // first permitted admin section (or settings if none), never a customer page
  // like the dashboard/AI Brain which would hang forever waiting for a profile.
  if (user?.role === "STAFF") return staffLandingPath(user.permissions ?? []);
  const profile = user?.profile;
  if (!profile) return "/dashboard";
  const step = profile.onboardingStep ?? 0;
  // Card required at signup and no card yet → the plan/card screen is the only
  // place they can go. This has to be decided BEFORE the onboardingCompletedAt
  // check below: a direct (non-funnel) signup is stamped complete at creation, so
  // onboarding state alone could never hold this wall.
  // The one exception is a guided-funnel signup still mid-flow — it finishes
  // Services/Overview first (exactly as the old pricing wall did), and Step7Finish
  // then parks it on ONBOARDING_PRICING_STEP so the next login lands here.
  if (cardWallActive(user)) {
    const midFunnel =
      !profile.onboardingCompletedAt && step >= 5 && step < ONBOARDING_PRICING_STEP;
    return midFunnel ? "/onboarding" : "/subscribe";
  }
  if (profile.onboardingCompletedAt) return "/dashboard";
  // No plan/card wall for a card-less signup — onboarding finishes at the Overview
  // step and the dashboard is always reachable. A user still mid-funnel (paused on
  // Services/Overview) resumes the guided flow; anyone past it lands on the
  // dashboard, where the "tap to set up" wizard collects plan + card if/when they
  // claim a number.
  if (step >= 5 && step < ONBOARDING_PRICING_STEP) return "/onboarding";
  return "/dashboard";
}
