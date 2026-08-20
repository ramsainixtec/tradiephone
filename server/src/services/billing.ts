import { prisma } from "../prisma.js";
import { endTrialNow } from "./stripe.js";

/* Global free-trial length (days). Stored in PlatformSetting, admin-editable. */
export const TRIAL_DAYS_KEY = "trial.days";
export const DEFAULT_TRIAL_DAYS = 14;

/* Global free-trial minute quota. The trial ends when EITHER limit (days or
 * minutes of call usage) is reached first. */
export const TRIAL_MINUTES_KEY = "trial.minutes";
export const DEFAULT_TRIAL_MINUTES = 10;

export async function getTrialDays(): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_DAYS_KEY } });
  return row ? Number(row.value) || DEFAULT_TRIAL_DAYS : DEFAULT_TRIAL_DAYS;
}

export async function getTrialMinutes(): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_MINUTES_KEY } });
  return row ? Number(row.value) || DEFAULT_TRIAL_MINUTES : DEFAULT_TRIAL_MINUTES;
}

/* Post-trial grace period: when a trial ends and the user doesn't convert, hold
 * their assigned number for this many days before releasing it back to the pool.
 * On/off + length are admin-editable PlatformSettings; on by default. */
export const GRACE_ENABLED_KEY = "grace.enabled";
export const GRACE_DAYS_KEY = "grace.days";
export const DEFAULT_GRACE_ENABLED = true;
export const DEFAULT_GRACE_DAYS = 7;

export async function getGraceConfig(): Promise<{ enabled: boolean; days: number }> {
  const [enabledRow, daysRow] = await Promise.all([
    prisma.platformSetting.findUnique({ where: { key: GRACE_ENABLED_KEY } }),
    prisma.platformSetting.findUnique({ where: { key: GRACE_DAYS_KEY } }),
  ]);
  return {
    enabled: enabledRow ? enabledRow.value === "true" : DEFAULT_GRACE_ENABLED,
    days: daysRow ? Number(daysRow.value) || DEFAULT_GRACE_DAYS : DEFAULT_GRACE_DAYS,
  };
}

/**
 * End a trialing customer's trial early once they've used up their trial-minute
 * quota. Ending the Stripe trial charges the saved card and flips the sub to
 * active (a customer.subscription.updated webhook then syncs the status too).
 * The days-based limit is enforced by Stripe's own trial_period_days, so this
 * only covers the "minutes ran out first" case. Best-effort and a no-op unless
 * the user is actively trialing with a Stripe subscription AND has auto-renew on
 * — with auto-renew off we never auto-charge; the trial simply lapses (calls
 * frozen) and Stripe cancels it at period end.
 */
export async function enforceTrialMinutes(userId: string): Promise<void> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { subscriptionStatus: true, stripeSubscriptionId: true, autoRenew: true },
  });
  if (!profile || profile.subscriptionStatus !== "trialing" || !profile.stripeSubscriptionId) return;

  // Auto-renew OFF → never auto-charge. A trial that runs out of minutes with
  // auto-renew disabled must NOT convert to a paid plan: the user is already
  // blocked (calls frozen) by the entitlement's expired_minutes status, and
  // Stripe cancels the trial at its end via cancel_at_period_end — no charge.
  // Mirrors reconcileSubscription's guard so BOTH trial-end paths (minutes here,
  // date there) respect the user's auto-renew choice.
  if (!profile.autoRenew) return;

  const quota = await getTrialMinutes();
  if (quota <= 0) return; // defensive — quota is always ≥ 1 via admin validation

  const conversion = await prisma.conversion.findUnique({
    where: { userId },
    include: { callLogs: { select: { durationSec: true } } },
  });
  if (!conversion) return;

  const minutesUsed = conversion.callLogs.reduce((sum, l) => sum + l.durationSec, 0) / 60;
  if (minutesUsed < quota) return;

  try {
    await endTrialNow(profile.stripeSubscriptionId);
    await prisma.profile.update({
      where: { userId },
      data: { subscriptionStatus: "active", trialEndsAt: null },
    });
  } catch {
    /* best-effort — the webhook or the next call will retry */
  }
}
