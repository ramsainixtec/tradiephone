import { sendDigests, getLastDigestRun } from "./reports.js";
import { syncVapiWithDb } from "./provisioning.js";
import { replenishPool, releaseUserNumberToPool } from "./phones.js";
import { integrationsStatus } from "./settings.js";
import { isTwilioConfigured } from "./sms.js";
import { prisma } from "../prisma.js";
import { formatDateDMY } from "../lib/date.js";
import { getGraceConfig } from "./billing.js";
import { getEntitlement, daysRemaining } from "./trial.js";
import { decideGraceAction } from "./grace.js";
import { graceStartedEmail, graceWarningEmail, graceEndedEmail } from "./email.js";
import { notify, notifyAdmins } from "./notifications.js";
import { pruneApiRequestLogs, RETENTION_DAYS, installTraceShutdownHook } from "./apiTrace.js";
import { evaluateAlertRules } from "./apiAlerts.js";
import { sweepStalePendingRedemptions } from "./coupons.js";
import { retryPendingVapiSyncs } from "./vapiSync.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const VAPI_SYNC_MS = 30 * 60 * 1000; // reconcile Vapi orphans every 30 minutes
const VAPI_RESYNC_MS = 5 * 60 * 1000; // retry failed config pushes every 5 minutes

let started = false;

async function maybeRunDigests(): Promise<void> {
  try {
    const last = await getLastDigestRun();
    const due = !last || Date.now() - new Date(last).getTime() >= WEEK_MS;
    if (due) {
      const result = await sendDigests();
      console.log(`📬 Weekly digests sent: ${result.sent}, skipped: ${result.skipped}`);
    }
  } catch (e) {
    console.warn("Digest scheduler tick failed:", e instanceof Error ? e.message : e);
  }
}

/** Clean up Vapi assistants/numbers that no longer belong to any DB user (e.g.
 *  a user deleted directly in the DB) — their number returns to the pool. */
async function runVapiSync(): Promise<void> {
  try {
    if (!integrationsStatus().vapi) return;
    const { deletedAssistants, releasedNumbers } = await syncVapiWithDb();
    if (deletedAssistants || releasedNumbers) {
      console.log(
        `🧹 Vapi sync: removed ${deletedAssistants} orphaned assistant(s), released ${releasedNumbers} number(s).`,
      );
    }
  } catch (e) {
    console.warn("Vapi sync tick failed:", e instanceof Error ? e.message : e);
  }
}

/** Re-push saved configs whose last push to Vapi failed, so a live agent that
 *  fell behind during an outage catches up on its own instead of waiting for the
 *  owner to notice and press Save again. */
async function runVapiResync(): Promise<void> {
  try {
    const { recovered, attempted } = await retryPendingVapiSyncs();
    if (recovered) {
      console.log(`🔁 Vapi re-sync: ${recovered}/${attempted} live agent(s) caught up.`);
    }
  } catch (e) {
    console.warn("Vapi re-sync tick failed:", e instanceof Error ? e.message : e);
  }
}

/** Keep the system phone pool topped up to its target (imports owned Twilio
 *  numbers, buys more only if auto-purchase is enabled). Best-effort. */
async function runReplenish(): Promise<void> {
  try {
    if (!isTwilioConfigured()) return;
    const r = await replenishPool();
    if (r.imported || r.purchased) {
      console.log(`📞 Pool replenish: imported ${r.imported}, purchased ${r.purchased} (now ${r.available}/${r.target}).`);
    }
  } catch (e) {
    console.warn("Pool replenish tick failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Post-trial grace sweep. For each lapsed-trial customer whose number is still
 * held: grant the grace window on first sight, send the reminder + final-24h
 * nudges (once each, monotonic via graceNotifyStage), and release the number to
 * the pool once the window lapses. A user who pays mid-grace clears immediately
 * via applyActivePlanMinutes; here we also clear as a backstop. Best-effort.
 */
async function runGraceSweep(): Promise<void> {
  try {
    const cfg = await getGraceConfig();
    if (!cfg.enabled) return;
    const now = new Date();

    const candidates = await prisma.profile.findMany({
      where: {
        graceConsumedAt: null,
        OR: [
          { graceEndsAt: { not: null } },
          { receptionistNumber: { not: "" }, graceStartedAt: null },
        ],
      },
      select: {
        userId: true,
        subscriptionStatus: true,
        currentPeriodEnd: true,
        receptionistNumber: true,
        graceStartedAt: true,
        graceEndsAt: true,
        graceNotifyStage: true,
        user: { select: { email: true, fullName: true } },
      },
    });

    const emailOn = integrationsStatus().email;

    for (const p of candidates) {
      try {
        const ent = await getEntitlement(p.userId, now);
        const email = p.user?.email;
        const fullName = p.user?.fullName || "there";
        const number = p.receptionistNumber || "your number";

        // A paid plan counts as "lapsed" for grace once it can no longer renew and
        // its period is over: either Stripe already canceled it at period end
        // (subscriptionStatus "canceled"), OR it's still "active" with auto-renew
        // OFF and the period end has passed — Stripe WILL cancel it, but that webhook
        // can lag (or never reach a given instance). Auto-renew ON is excluded: that
        // plan renews at period end, so a briefly-past period end is just webhook lag,
        // not a lapse — grabbing its number would be wrong.
        const periodEnded =
          !!p.currentPeriodEnd && now.getTime() >= p.currentPeriodEnd.getTime();
        const planLapsed =
          p.subscriptionStatus === "canceled" ||
          (p.subscriptionStatus === "active" && !ent.autoRenew && periodEnded);

        const action = decideGraceAction({
          enabled: cfg.enabled,
          days: cfg.days,
          blocked: ent.blocked,
          isTrial: ent.isTrial,
          // Lapsed paid plan (canceled, or period-ended with auto-renew off) still
          // holds its number — grace now covers it too, so the number is reserved for
          // the window then released, same as a lapsed trial.
          planLapsed,
          hasNumber: !!p.receptionistNumber,
          graceStartedAt: p.graceStartedAt,
          graceEndsAt: p.graceEndsAt,
          graceNotifyStage: p.graceNotifyStage,
          now,
        });

        switch (action.type) {
          case "noop":
            break;

          case "clear":
            await prisma.profile.update({
              where: { userId: p.userId },
              data: { graceStartedAt: null, graceEndsAt: null, graceNotifyStage: null },
            });
            break;

          case "start": {
            await prisma.profile.update({
              where: { userId: p.userId },
              data: { graceStartedAt: now, graceEndsAt: action.graceEndsAt, graceNotifyStage: "granted" },
            });
            if (email && emailOn) {
              await graceStartedEmail({
                ownerEmail: email,
                fullName,
                graceDays: cfg.days,
                graceEndsAt: action.graceEndsAt,
                number,
              });
            }
            void notify(p.userId, {
              type: "billing",
              title: "Your number is reserved during a grace period",
              message: `Pick a plan before ${formatDateDMY(action.graceEndsAt)} to keep your number.`,
              link: "/dashboard/plans",
            });
            break;
          }

          case "reminder":
          case "final": {
            if (email && emailOn) {
              await graceWarningEmail({
                ownerEmail: email,
                fullName,
                daysRemaining: daysRemaining(p.graceEndsAt, now),
                graceEndsAt: p.graceEndsAt!,
                number,
                final: action.type === "final",
              });
            }
            await prisma.profile.update({
              where: { userId: p.userId },
              data: { graceNotifyStage: action.type },
            });
            break;
          }

          case "release": {
            const freed = await releaseUserNumberToPool(p.userId);
            await prisma.profile.update({
              where: { userId: p.userId },
              // Grace lapsed without renewal → fully suspend: number gone + the
              // dashboard locks behind the reactivation screen until they pick a plan.
              data: { graceConsumedAt: now, graceEndsAt: null, subscriptionStatus: "suspended" },
            });
            if (email && emailOn) {
              await graceEndedEmail({ ownerEmail: email, fullName, number: freed ?? number });
            }
            void notify(p.userId, {
              type: "billing",
              title: "Your reserved number was released",
              message: "Your grace period ended. Pick a plan to get a new number.",
              link: "/dashboard/plans",
            });
            void notifyAdmins({
              type: "system",
              title: "Grace period lapsed — number released",
              message: `${email ?? p.userId} lost their reserved number ${freed ?? number}.`,
            });
            break;
          }
        }
      } catch (e) {
        console.warn("Grace sweep (user) failed:", e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn("Grace sweep tick failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Release coupon reservations left behind by abandoned checkouts, so a capped
 * campaign isn't held hostage by shoppers who never paid. The rows are DELETED
 * rather than marked — a leftover row would trip the unique (couponId, userId)
 * index and permanently lock the user out of a code they never actually used.
 */
async function runCouponSweep(): Promise<void> {
  try {
    const released = await sweepStalePendingRedemptions();
    if (released > 0) console.log(`🎟️  Coupon sweep: released ${released} stale reservation(s)`);
  } catch (e) {
    console.warn("Coupon sweep tick failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start background schedulers. Idempotent.
 *  - Vapi reconcile: opt-in via ENABLE_VAPI_RECONCILE=true — clears orphaned
 *    assistants/numbers periodically (first pass shortly after boot, then every
 *    30 min). Destructive, so off by default and meant for one owning instance.
 *  - Vapi config re-sync: always on — retries config pushes that failed (every
 *    5 min), so a live agent left stale by an outage repairs itself.
 *  - Pool replenish: always on — keeps the system pool at its target size.
 *  - Grace sweep + coupon sweep: always on, hourly.
 *  - Weekly digests: opt-in via ENABLE_DIGESTS=true so dev never surprise-emails.
 */
export function startScheduler(): void {
  if (started) return;
  started = true;

  // Reconcile is destructive (it deletes Vapi assistants/numbers absent from THIS
  // DB), so it must run on exactly one instance that owns the Vapi account. Any
  // other instance sharing the Vapi key (dev box, staging) would wipe the account.
  // Opt-in via ENABLE_VAPI_RECONCILE=true so it never runs by surprise.
  if (process.env.ENABLE_VAPI_RECONCILE === "true") {
    setTimeout(() => void runVapiSync(), 30_000);
    setInterval(() => void runVapiSync(), VAPI_SYNC_MS);
    console.log("🧹 Vapi reconcile scheduler started (every 30 min)");
  } else {
    console.log("🧹 Vapi reconcile scheduler disabled (set ENABLE_VAPI_RECONCILE=true to enable)");
  }

  // Unlike reconcile above, this one is always on: it only re-pushes configs this
  // DB already owns to assistants that already exist, so it deletes nothing and a
  // second instance running it at the same time just repeats an idempotent PATCH.
  setTimeout(() => void runVapiResync(), 100_000);
  setInterval(() => void runVapiResync(), VAPI_RESYNC_MS);
  console.log("🔁 Vapi config re-sync scheduler started (every 5 min)");

  setTimeout(() => void runReplenish(), 45_000);
  setInterval(() => void runReplenish(), VAPI_SYNC_MS);
  console.log("📞 Pool replenish scheduler started (every 30 min)");

  setTimeout(() => void runGraceSweep(), 60_000);
  setInterval(() => void runGraceSweep(), HOUR_MS);
  console.log("🛟 Grace-period sweep scheduler started (hourly)");

  setTimeout(() => void runCouponSweep(), 75_000);
  setInterval(() => void runCouponSweep(), HOUR_MS);
  console.log("🎟️  Coupon reservation sweep scheduler started (hourly)");

  if (process.env.ENABLE_DIGESTS === "true") {
    void maybeRunDigests();
    setInterval(() => void maybeRunDigests(), HOUR_MS);
    console.log("⏰ Weekly digest scheduler started (ENABLE_DIGESTS=true)");
  }

  // API Center. Alerts are evaluated every five minutes so a provider that goes
  // down out of hours is already flagged when someone looks; the log sweep runs
  // daily because api_request_logs takes a write on every outbound call and would
  // otherwise grow without limit.
  installTraceShutdownHook();
  setTimeout(() => void evaluateAlertRules(), 90_000);
  setInterval(() => void evaluateAlertRules(), 5 * 60 * 1000);
  setTimeout(() => void runApiLogSweep(), 5 * 60 * 1000);
  setInterval(() => void runApiLogSweep(), DAY_MS);
  console.log(`🔌 API Center schedulers started (alerts every 5 min, log sweep daily)`);
}

/** Drop API request rows past the retention window. */
async function runApiLogSweep(): Promise<void> {
  try {
    const deleted = await pruneApiRequestLogs();
    if (deleted > 0) console.log(`🧽 Pruned ${deleted} API request logs older than ${RETENTION_DAYS} days`);
  } catch (e) {
    console.warn("API log sweep failed:", e instanceof Error ? e.message : e);
  }
}
