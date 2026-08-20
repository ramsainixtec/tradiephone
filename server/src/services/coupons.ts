import type { Coupon, CouponRedemption } from "@prisma/client";
import { prisma } from "../prisma.js";
import {
  attachSubscriptionDiscount,
  createStripeCoupon,
  deleteStripeCoupon,
  detachSubscriptionDiscount,
  getSubscriptionDiscountCouponId,
  isStripeConfigured,
  setSchedulePhaseDiscounts,
  type StripeCouponDuration,
} from "./stripe.js";
import { recordPlanEvent } from "./planHistory.js";

/**
 * Coupons — discount codes redeemed at checkout or granted by an admin.
 *
 * All the rules live here so the routes stay thin (same shape as trial.ts).
 * Three lifetimes are deliberately kept separate, because conflating them is
 * how coupon systems go wrong:
 *
 *   • The COUPON (the shared code) lives until its redemption window closes,
 *     its supply cap is reached, or an admin deactivates it. One user redeeming
 *     it only increments `redeemedCount`.
 *   • A user's REDEMPTION is permanent — `@@unique([couponId, userId])` is what
 *     stops the same user redeeming the same code twice, enforced in the DB so
 *     a race or double-submit can't slip past it. A spent row is KEPT (status
 *     "exhausted") precisely because it is the record that blocks re-entry.
 *   • The DISCOUNT lasts `durationCycles` billing cycles, then detaches.
 *
 * Cycles are counted by US, never by Stripe's calendar-month duration:
 * `renewActivePlanIfExhausted` renews early whenever a user burns their
 * minutes, so a heavy user can consume several cycles inside one calendar month
 * and Stripe would discount every one of them.
 */

/**
 * How long a `pending` reservation held during checkout stays valid. After this
 * the scheduler sweep DELETES it (never marks it) — a row left behind would trip
 * the unique constraint and permanently lock the user out of a code they
 * abandoned at checkout and never actually used.
 */
export const PENDING_RESERVATION_TTL_MS = 30 * 60 * 1000;

/** Plan events that prove an account has held a paid plan at some point. */
const PAID_PLAN_EVENT_TYPES = ["trial_converted", "renewed", "upgraded"];

/** Codes are stored and compared uppercase, so entry is case-insensitive. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Take a row lock on the user's profile for the rest of the transaction, so two
 * writers deciding this user's live discount run one after the other.
 *
 * Without it the "revoke everything active, then activate mine" pair is not
 * actually safe: Prisma runs at Postgres READ COMMITTED, so a customer's
 * /confirm-card and an admin's grant can both run their revoke before either
 * has inserted, each see nothing to revoke, and both commit an active row. No
 * unique index catches that — @@unique([couponId, userId]) only blocks the same
 * coupon twice, and a partial unique index is not available here (Prisma cannot
 * express one, and `prisma db push` would drop it on the next deploy).
 *
 * The profile row is the right thing to lock: it is the row that carries
 * `activeCouponRedemptionId`, so it is exactly the state being contended.
 */
async function lockUserCouponState(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM profiles WHERE "userId" = ${userId} FOR UPDATE`;
}

/**
 * True when a Prisma failure means the coupon tables simply aren't in this
 * database yet (P2021 = table does not exist).
 *
 * Deploy-order insurance. The coupon read paths are threaded through code every
 * customer hits — the minute grant, the renewal settle, GET /subscription — so
 * if the app ever runs against a database the migration hasn't reached, an
 * unguarded query would 500 those endpoints for the ENTIRE customer base over a
 * feature none of them use. Treating "no table" as "no coupons" makes the whole
 * system inert instead, and it heals itself the moment the migration lands.
 * Only this one error is swallowed; real failures still surface.
 */
function isMissingCouponTable(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2021";
}

export type CouponRejection =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "sold_out"
  | "already_used"
  | "already_discounted"
  | "not_new_customer"
  | "plan_not_eligible"
  | "stripe_unavailable";

/** Customer-facing copy per rejection. Deliberately vague about whether an
 *  unknown code exists, so the endpoint can't be used to enumerate codes. */
const REJECTION_MESSAGE: Record<CouponRejection, string> = {
  not_found: "That code isn't valid.",
  inactive: "That code isn't valid.",
  not_started: "That code isn't active yet.",
  expired: "That code has expired.",
  sold_out: "That code has been fully claimed.",
  already_used: "You've already used that code.",
  already_discounted: "You already have a discount running on this account.",
  not_new_customer: "That code is only for new customers.",
  plan_not_eligible: "That code doesn't apply to the plan you picked.",
  stripe_unavailable: "Discount codes aren't available right now.",
};

export function rejectionMessage(reason: CouponRejection): string {
  return REJECTION_MESSAGE[reason];
}

export type CouponValidation =
  | { ok: true; coupon: Coupon }
  | { ok: false; reason: CouponRejection };

/** Reservations still holding a slot (created inside the TTL). */
function livePendingWhere(couponId: string) {
  return {
    couponId,
    status: "pending",
    reservedAt: { gt: new Date(Date.now() - PENDING_RESERVATION_TTL_MS) },
  } as const;
}

/**
 * Has this account ever held a paid plan? Checked against PlanEvent history
 * rather than the current subscription status on purpose: a customer who
 * subscribed, cancelled and came back reads as "none" today but is plainly not
 * a new customer.
 */
async function hasEverPaid(userId: string): Promise<boolean> {
  const seen = await prisma.planEvent.findFirst({
    where: { userId, type: { in: PAID_PLAN_EVENT_TYPES } },
    select: { id: true },
  });
  return !!seen;
}

/**
 * Where a coupon sits relative to its redemption window right now.
 *
 * One definition for both doors — a customer typing the code and an admin
 * granting it — so "expired" can't mean two different things depending on which
 * one you came through.
 */
export function redemptionWindow(
  coupon: { startsAt: Date | null; expiresAt: Date | null },
  now = new Date(),
): "open" | "not_started" | "expired" {
  if (coupon.startsAt && coupon.startsAt > now) return "not_started";
  if (coupon.expiresAt && coupon.expiresAt <= now) return "expired";
  return "open";
}

/**
 * Can this user redeem this code against this plan, right now? Pure check — it
 * reserves nothing, so it's safe for the live-validation endpoint.
 */
export async function validateCoupon(input: {
  code: string;
  userId: string;
  planId: string;
}): Promise<CouponValidation> {
  const coupon = await prisma.coupon
    .findUnique({ where: { code: normalizeCode(input.code) } })
    // No coupon tables → no coupons to match, same as an unknown code.
    .catch((e: unknown) => {
      if (isMissingCouponTable(e)) return null;
      throw e;
    });
  if (!coupon) return { ok: false, reason: "not_found" };
  if (!coupon.active) return { ok: false, reason: "inactive" };

  const window = redemptionWindow(coupon);
  if (window !== "open") return { ok: false, reason: window };

  // A percentage discount is performed by Stripe; without Stripe we can't honour
  // it. A bonus-minutes-only coupon is entirely ours and still works.
  if (coupon.percentOff && !isStripeConfigured()) {
    return { ok: false, reason: "stripe_unavailable" };
  }

  if (coupon.planIds.length > 0 && !coupon.planIds.includes(input.planId)) {
    return { ok: false, reason: "plan_not_eligible" };
  }

  // A COMPLETED row blocks re-entry — `active` (running), `exhausted` (spent)
  // and `revoked` (cancelled without releasing the slot).
  //
  // A `pending` row never blocks, fresh or stale. It is THIS user's own
  // unfinished checkout: they reached the card step, backed out, and came round
  // again. Treating it as "already used" locked people out of their own coupon
  // for 30 minutes — and worse, made the retry fail outright, because
  // /subscribe re-validates before reserving. reserveRedemption reuses the row
  // rather than creating a second, so letting it through is safe.
  const existing = await prisma.couponRedemption.findUnique({
    where: { couponId_userId: { couponId: coupon.id, userId: input.userId } },
  });
  if (existing && existing.status !== "pending") return { ok: false, reason: "already_used" };

  // A DIFFERENT code while a discount is already running. /subscribe writes the
  // Stripe discount straight from the code in the request, and its only cleanup
  // (clearOtherPendingReservations) touches pending rows — never the live one. So
  // without this the customer's subscription would start billing under the new
  // code while our records still count cycles and grant bonus minutes for the old
  // one: two coupons on one account, no race required, and if they then abandon
  // checkout the new code was never even redeemed.
  //
  // Refused rather than silently swapped: the customer is told, and replacing a
  // live discount stays an admin action (grantCoupon), which retires the old one
  // properly instead of leaving it behind.
  const live = await getActiveRedemption(input.userId);
  if (live && live.couponId !== coupon.id) return { ok: false, reason: "already_discounted" };

  if (coupon.maxRedemptions != null) {
    const pending = await prisma.couponRedemption.count({ where: livePendingWhere(coupon.id) });
    // Don't count this user's own live reservation against them — it IS the
    // checkout they're retrying, so charging them for it would report the last
    // slot as sold out to the very person holding it.
    const ownLivePending = existing && existing.status === "pending" && !isStalePending(existing) ? 1 : 0;
    if (coupon.redeemedCount + pending - ownLivePending >= coupon.maxRedemptions) {
      return { ok: false, reason: "sold_out" };
    }
  }

  if (coupon.newCustomersOnly && (await hasEverPaid(input.userId))) {
    return { ok: false, reason: "not_new_customer" };
  }

  return { ok: true, coupon };
}

function isStalePending(r: CouponRedemption): boolean {
  return (
    r.status === "pending" &&
    r.reservedAt.getTime() <= Date.now() - PENDING_RESERVATION_TTL_MS
  );
}

/**
 * Hold a slot for a checkout in progress. The redemption does NOT count yet —
 * only `activateRedemption` (called once money actually moved) increments
 * `redeemedCount`. Until then it's a `pending` row that occupies a slot against
 * the cap and is swept away if the checkout is abandoned.
 *
 * The cap is re-checked inside the transaction so two shoppers racing for the
 * last slot can't both win.
 */
export async function reserveRedemption(
  couponId: string,
  userId: string,
): Promise<CouponRedemption> {
  const cutoff = new Date(Date.now() - PENDING_RESERVATION_TTL_MS);
  return prisma.$transaction(async (tx) => {
    // Clear this user's own abandoned reservation first: without it the unique
    // constraint would reject a perfectly legitimate retry until the hourly
    // sweep happened to run.
    await tx.couponRedemption.deleteMany({
      where: { couponId, userId, status: "pending", reservedAt: { lte: cutoff } },
    });

    // A fresh reservation already exists (double-submit, or the user stepped
    // back and forward again) → reuse it rather than failing the checkout.
    const existing = await tx.couponRedemption.findUnique({
      where: { couponId_userId: { couponId, userId } },
    });
    if (existing) return existing;

    const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
    if (!coupon) throw new Error("coupon not found");
    if (coupon.maxRedemptions != null) {
      const pending = await tx.couponRedemption.count({
        where: { couponId, status: "pending", reservedAt: { gt: cutoff } },
      });
      if (coupon.redeemedCount + pending >= coupon.maxRedemptions) {
        throw new Error("coupon sold out");
      }
    }

    return tx.couponRedemption.create({
      data: { couponId, userId, status: "pending" },
    });
  });
}

/**
 * Promote this user's held reservation to a live discount. Called from
 * /confirm-card once the card was actually charged — the ONE place a redemption
 * counts, so an abandoned checkout never burns a campaign's supply.
 *
 * Any discount already running is revoked first: one live discount per account.
 */
export async function activateRedemption(
  userId: string,
  subscriptionId?: string | null,
): Promise<void> {
  let pending = await prisma.couponRedemption.findFirst({
    where: { userId, status: "pending" },
    orderBy: { reservedAt: "desc" },
    include: { coupon: true },
  });

  // No reservation left, but the charge just succeeded. The checkout outlasted
  // the sweep window — typically a declined card the customer took half an hour
  // to replace. The subscription still carries the discount attached at
  // creation, so the invoice they were just charged IS discounted; recovering
  // the record here is what stops a real multi-cycle discount running with
  // nothing counting its cycles (and, for a `forever` coupon, running forever).
  if (!pending && subscriptionId) {
    pending = await recoverRedemptionFromSubscription(userId, subscriptionId);
  }

  if (!pending) return;

  // Retiring the old discount and starting the new one is ONE transaction. Split
  // across two, a second caller arriving in the gap (a double-submitted
  // /confirm-card, or an admin granting while the customer redeems) could revoke
  // an already-revoked row and then activate its own — leaving two rows live,
  // which nothing in the schema forbids.
  //
  // updateMany, not the single row getActiveRedemption returns: if a collision
  // already exists in the data, this is where it gets cleaned up rather than
  // preserved. A replaced row keeps blocking re-entry (the user did consume it),
  // it just stops discounting.
  await prisma.$transaction(async (tx) => {
    await lockUserCouponState(tx, userId);
    await tx.couponRedemption.updateMany({
      where: { userId, status: "active" },
      data: { status: "revoked", endedAt: new Date() },
    });
    await tx.couponRedemption.update({
      where: { id: pending.id },
      data: { status: "active", appliedAt: new Date() },
    });
    await tx.coupon.update({
      where: { id: pending.couponId },
      data: { redeemedCount: { increment: 1 } },
    });
    await tx.profile.update({
      where: { userId },
      data: { activeCouponRedemptionId: pending.id },
    });
  });

  // Make Stripe agree with the row we just made live. Deliberately not
  // revokeRedemption's detach-then-activate: the new coupon was already attached
  // at /subscribe, and detaching afterwards would strip the discount the customer
  // is about to be charged under.
  await syncStripeDiscountTo(userId, subscriptionId ?? null, pending.coupon);

  void recordPlanEvent({
    userId,
    type: "coupon_applied",
    note: couponAppliedNote(pending.coupon),
  });
}

/**
 * Rebuild a lost reservation from whatever discount Stripe actually has on the
 * subscription, so the record always matches what the customer is being charged.
 *
 * Returns null when there's nothing to recover — no discount attached, a
 * discount that isn't ours (someone applied a coupon by hand in the Stripe
 * dashboard), or a coupon this user already has a row for. That last guard
 * matters: without it this would resurrect a spent or revoked redemption and
 * hand the customer a second run at a code they've already used.
 */
async function recoverRedemptionFromSubscription(
  userId: string,
  subscriptionId: string,
): Promise<(CouponRedemption & { coupon: Coupon }) | null> {
  try {
    if (!isStripeConfigured()) return null;
    const attached = await getSubscriptionDiscountCouponId(subscriptionId);
    if (!attached) return null;

    const coupon = await prisma.coupon.findFirst({ where: { stripeCouponId: attached } });
    if (!coupon) return null;

    const prior = await prisma.couponRedemption.findUnique({
      where: { couponId_userId: { couponId: coupon.id, userId } },
    });
    if (prior) return null;

    return await prisma.couponRedemption.create({
      data: { couponId: coupon.id, userId, status: "pending" },
      include: { coupon: true },
    });
  } catch {
    // Never let recovery break an otherwise successful activation.
    return null;
  }
}

/**
 * Make Stripe's subscription discount match the redemption we just made live.
 *
 * Attaching writes `discounts: [one]`, which REPLACES rather than appends — so
 * for a percentage coupon this both applies the new one and clears the old in a
 * single call.
 *
 * The case worth spelling out is a bonus-minutes-only coupon: it has no Stripe
 * object because it discounts no money. Making one live while a percentage
 * discount is still attached would leave the customer paying less under a coupon
 * that is no longer their live redemption — so nothing would ever count its
 * cycles or retire it. Clearing it is the only way the two states agree.
 */
async function syncStripeDiscountTo(
  userId: string,
  subscriptionId: string | null,
  coupon: Coupon,
): Promise<void> {
  let subId = subscriptionId;
  if (!subId) {
    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: { stripeSubscriptionId: true },
    });
    subId = profile?.stripeSubscriptionId ?? null;
  }
  if (!subId || !isStripeConfigured()) return;
  try {
    if (coupon.stripeCouponId) {
      await attachSubscriptionDiscount(subId, coupon.stripeCouponId);
    } else {
      const attached = await getSubscriptionDiscountCouponId(subId);
      if (attached) await detachSubscriptionDiscount(subId);
    }
    await mirrorDiscountOntoSchedule(userId, coupon.stripeCouponId ?? null);
  } catch {
    /* best-effort — healDiscountDrift repairs it on the next reconcile */
  }
}

/**
 * Carry a discount change onto any pending downgrade schedule.
 *
 * A schedule freezes the coupon that was attached when it was created and
 * re-applies it when it takes over at the period boundary — so changing the live
 * discount without this leaves a queued instruction to put the old one back.
 */
async function mirrorDiscountOntoSchedule(
  userId: string,
  stripeCouponId: string | null,
): Promise<void> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { stripeScheduleId: true },
  });
  if (!profile?.stripeScheduleId) return;
  await setSchedulePhaseDiscounts(profile.stripeScheduleId, stripeCouponId).catch(() => {
    /* schedule already released/completed, or Stripe hiccup — nothing to correct */
  });
}

function couponAppliedNote(coupon: Coupon): string {
  const parts: string[] = [];
  if (coupon.percentOff) parts.push(`${coupon.percentOff}% off`);
  if (coupon.bonusMinutes) parts.push(`+${coupon.bonusMinutes} bonus minutes`);
  const cycles = coupon.durationCycles === 1 ? "the first charge" : `${coupon.durationCycles} billing cycles`;
  return `Coupon ${coupon.code} applied — ${parts.join(" and ")} for ${cycles}`;
}

/**
 * The live discount for a user, or null.
 *
 * The single read every other coupon-aware path goes through — the discount
 * itself, the bonus minutes, the cycle counting, the revoke and the Stripe drift
 * repair all resolve a user's coupon here. That makes this function, and not any
 * caller, the place where "one live discount per account" is decided.
 *
 * `Profile.activeCouponRedemptionId` is the authority. A scan for
 * `status: "active"` is not: nothing in the database stops a user owning two such
 * rows (`@@unique([couponId, userId])` only blocks the SAME coupon twice), and an
 * unordered findFirst would then return an arbitrary one — leaving the other as a
 * ghost that no cycle ever counts and no revoke ever clears, while still blocking
 * that code's re-entry. A single-valued pointer cannot express two live discounts
 * at all, so reading through it makes stacking structurally impossible for every
 * caller at once.
 *
 * The status scan survives as a FALLBACK for a null pointer, and heals it. Losing
 * the pointer must not make a running discount invisible — Stripe would keep
 * applying it with nothing left to retire it, which is the expensive direction of
 * this bug rather than the safe one.
 *
 * The missing-table guard lives here too: on a database without the coupon tables
 * this answers "no discount" and the rest of the system behaves exactly as it did
 * before coupons existed.
 */
export async function getActiveRedemption(
  userId: string,
): Promise<(CouponRedemption & { coupon: Coupon }) | null> {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: { activeCouponRedemptionId: true },
    });

    if (profile?.activeCouponRedemptionId) {
      const pointed = await prisma.couponRedemption.findUnique({
        where: { id: profile.activeCouponRedemptionId },
        include: { coupon: true },
      });
      // Trust the pointer only while it still names a LIVE row. A stale pointer
      // (row retired, deleted, or somehow another user's) falls through to the
      // scan rather than reporting a discount that has already ended.
      if (pointed && pointed.userId === userId && pointed.status === "active") return pointed;
    }

    const scanned = await prisma.couponRedemption.findFirst({
      where: { userId, status: "active" },
      // Deterministic: if rows ever did collide, the newest is the one the
      // customer most recently redeemed, and the one Stripe will be carrying.
      orderBy: { appliedAt: "desc" },
      include: { coupon: true },
    });
    if (!scanned) return null;

    // Heal, and CLEAN UP while we are here. Pointing at the winner without
    // retiring its siblings would leave them for the next pointer-null read to
    // find — so a coupon that was superseded months ago could come back to life,
    // start granting its bonus minutes again and get re-attached to Stripe. One
    // read of a collided state has to end the collision, not just step over it.
    await prisma
      .$transaction([
        prisma.couponRedemption.updateMany({
          where: { userId, status: "active", id: { not: scanned.id } },
          data: { status: "revoked", endedAt: new Date() },
        }),
        prisma.profile.update({
          where: { userId },
          data: { activeCouponRedemptionId: scanned.id },
        }),
      ])
      .catch(() => {
        /* best-effort heal — the scan already answered the question */
      });
    return scanned;
  } catch (e) {
    if (isMissingCouponTable(e)) return null;
    throw e;
  }
}

/**
 * Release any reservation this user holds for a code OTHER than the one they're
 * checking out with now. Runs on every /subscribe, coupon or not, so it carries
 * the same missing-table guard.
 */
export async function clearOtherPendingReservations(
  userId: string,
  keepCouponId?: string | null,
): Promise<void> {
  try {
    await prisma.couponRedemption.deleteMany({
      where: {
        userId,
        status: "pending",
        ...(keepCouponId ? { couponId: { not: keepCouponId } } : {}),
      },
    });
  } catch (e) {
    if (!isMissingCouponTable(e)) throw e;
  }
}

/** Two period ends within an hour describe the same cycle (the tolerance
 *  `applyActivePlanMinutes` uses — far below a real cycle, far above jitter). */
const SAME_PERIOD_MS = 60 * 60 * 1000;

/**
 * Re-attach a discount that should be live but isn't.
 *
 * Stripe can drop a subscription discount without anyone asking: writing a
 * subscription schedule's phases replaces them wholesale, so a phase that
 * doesn't restate `discounts` loses it (scheduleDowngrade now restates it —
 * this is the net under that). A dropped discount fails silently: nothing
 * errors, the customer simply starts paying full price with cycles still owed.
 *
 * A `once` coupon is excluded on purpose: Stripe removes those itself after the
 * first invoice, so "missing" is the correct state, and re-attaching would hand
 * out a discount that was already spent.
 */
async function ensureDiscountAttached(
  userId: string,
  subscriptionId: string | null,
  coupon: Coupon,
): Promise<void> {
  if (!subscriptionId || !coupon.stripeCouponId) return;
  if (coupon.durationCycles <= 1) return;
  if (!isStripeConfigured()) return;
  try {
    const attached = await getSubscriptionDiscountCouponId(subscriptionId);
    // Already the right one → nothing to do. A DIFFERENT coupon is not "close
    // enough" to leave alone: the customer would be billed under one coupon while
    // we count cycles against another, so that one never retires and this one
    // never applies. Attaching replaces it.
    if (attached === coupon.stripeCouponId) return;
    await attachSubscriptionDiscount(subscriptionId, coupon.stripeCouponId);
    void recordPlanEvent({
      userId,
      type: "coupon_reattached",
      note: attached
        ? `The subscription was carrying a different discount; coupon ${coupon.code} has been re-applied`
        : `Coupon ${coupon.code} was missing from the subscription and has been re-applied`,
    });
  } catch {
    /* best-effort — never break a renewal over a discount repair */
  }
}

/**
 * Count one billing cycle against the live discount, and retire it when the
 * budget is spent.
 *
 * Called on EVERY charge — the checkout charge, the trial conversion, Stripe's
 * native date renewal and our early minutes-exhausted renewal alike — which is
 * the whole reason cycles are counted here rather than handed to Stripe as a
 * calendar-month count.
 *
 * ORDER MATTERS: call this AFTER the charge and AFTER the minute grant for that
 * charge. The cycle being paid for is one the coupon still covers, so its
 * discount and bonus minutes both belong to it; consuming first would retire a
 * single-cycle coupon before it granted the very bonus minutes it promised.
 * Retiring here still detaches the Stripe discount well before the NEXT invoice.
 *
 * `cyclePeriodEnd` is the period the charge opened, and makes this idempotent:
 * an early renewal counts its cycle and then fires a
 * `customer.subscription.updated` webhook that would otherwise count the same
 * cycle again, halving the customer's discount.
 */
export async function consumeCycle(
  userId: string,
  subscriptionId: string | null,
  cyclePeriodEnd: Date | null,
  /** The Stripe invoice this charge produced, when the caller knows it. */
  invoiceId?: string | null,
): Promise<void> {
  try {
    const live = await getActiveRedemption(userId);
    if (!live) return;

    // Already counted → a repeat event, not a cycle.
    //
    // The invoice id is the precise key: one paid invoice is one charge is one
    // cycle. Prefer it whenever the caller has it, and do NOT fall through to the
    // period-end window afterwards — that window cannot tell a repeat event apart
    // from a genuine second charge, because an early renewal anchors the new
    // cycle at "now". Two renewals on the same day (a customer burning their
    // minutes, which is precisely what early renewal exists for) then report
    // period ends minutes apart, and treating the second as a duplicate meant the
    // discount never spent its budget.
    if (invoiceId) {
      if (live.lastCountedInvoiceId === invoiceId) return;
    } else if (
      cyclePeriodEnd &&
      live.lastCountedPeriodEnd &&
      Math.abs(cyclePeriodEnd.getTime() - live.lastCountedPeriodEnd.getTime()) < SAME_PERIOD_MS
    ) {
      // No invoice to key on — fall back to the period window, which is still
      // right for the event-driven callers that carry no charge of their own.
      return;
    }

    const counted = {
      lastCountedPeriodEnd: cyclePeriodEnd ?? live.lastCountedPeriodEnd,
      ...(invoiceId ? { lastCountedInvoiceId: invoiceId } : {}),
    };

    const cyclesUsed = live.cyclesUsed + 1;
    if (cyclesUsed < live.coupon.durationCycles) {
      await prisma.couponRedemption.update({
        where: { id: live.id },
        data: { cyclesUsed, ...counted },
      });
      // Cycles still owed → make sure Stripe still knows. Checked HERE, at a
      // cycle boundary, rather than on the reconcile path that every gated API
      // request runs through: a per-request Stripe call for every discounted
      // customer would be a heavy price for a rare repair.
      await ensureDiscountAttached(userId, subscriptionId, live.coupon);
      return;
    }

    // Budget spent → retire it. The row STAYS as `exhausted`: it is what stops
    // this user redeeming the same code again.
    await prisma.$transaction([
      prisma.couponRedemption.update({
        where: { id: live.id },
        data: {
          cyclesUsed,
          status: "exhausted",
          endedAt: new Date(),
          ...counted,
        },
      }),
      prisma.profile.update({
        where: { userId },
        data: { activeCouponRedemptionId: null },
      }),
    ]);

    // A single-cycle coupon is a Stripe `once` coupon, which Stripe removes by
    // itself — no detach call needed (or wanted).
    if (subscriptionId && live.coupon.durationCycles > 1 && isStripeConfigured()) {
      await detachSubscriptionDiscount(subscriptionId).catch(() => {
        /* healed by healDiscountDrift on the next reconcile */
      });
    }
    // And out of any pending downgrade. A schedule freezes the coupon that was
    // attached when it was created and re-applies it when it takes over at the
    // period boundary — so detaching from the subscription alone would hand the
    // customer one more discounted invoice on a budget that is already spent.
    await mirrorDiscountOntoSchedule(userId, null);

    void recordPlanEvent({
      userId,
      type: "coupon_expired",
      note: `Coupon ${live.coupon.code} finished — its ${live.coupon.durationCycles} billing cycle(s) are used up, so the next charge is full price`,
    });
  } catch {
    /* never let coupon bookkeeping break a renewal */
  }
}

/**
 * End a user's live discount early.
 *
 * `releaseSlot: false` (the default) marks it `revoked` — the row stays, so the
 * user still can't redeem that code again. That's right for a replacement (they
 * did consume it) and for a deliberate admin removal.
 *
 * `releaseSlot: true` DELETES the row and gives the supply slot back, so the
 * user may redeem the code again. That's the undo path for a coupon granted by
 * mistake, and it's why the admin revoke UI asks.
 */
export async function revokeRedemption(
  userId: string,
  opts: { reason?: string; releaseSlot?: boolean } = {},
): Promise<boolean> {
  const live = await getActiveRedemption(userId);
  if (!live) return false;

  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { stripeSubscriptionId: true },
  });

  if (opts.releaseSlot) {
    await prisma.$transaction([
      prisma.couponRedemption.delete({ where: { id: live.id } }),
      // Only a redemption that actually counted should be given back.
      prisma.coupon.update({
        where: { id: live.couponId },
        data: { redeemedCount: { decrement: 1 } },
      }),
      prisma.profile.update({ where: { userId }, data: { activeCouponRedemptionId: null } }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.couponRedemption.update({
        where: { id: live.id },
        data: { status: "revoked", endedAt: new Date() },
      }),
      prisma.profile.update({ where: { userId }, data: { activeCouponRedemptionId: null } }),
    ]);
  }

  if (profile?.stripeSubscriptionId && isStripeConfigured()) {
    await detachSubscriptionDiscount(profile.stripeSubscriptionId).catch(() => {
      /* healed by healDiscountDrift on the next reconcile */
    });
  }
  // Same reason as the exhaust path: a pending downgrade carries its own copy of
  // the discount and would put it straight back at the period boundary.
  await mirrorDiscountOntoSchedule(userId, null);

  void recordPlanEvent({
    userId,
    type: "coupon_expired",
    note: opts.reason ?? `Coupon ${live.coupon.code} removed`,
  });
  return true;
}

/**
 * Give a customer a coupon directly, without them typing a code — the
 * retention/comp path.
 *
 * Deliberately skips the `newCustomersOnly` and redemption-window checks: an
 * admin granting a coupon is making a decision about this specific account, and
 * those rules exist to govern self-serve redemption. The per-user limit is NOT
 * skipped — the unique index still means one redemption per code per user, so a
 * customer can't be given the same code twice.
 *
 * Any live discount is replaced (one per account), and the discount attaches to
 * the subscription immediately, so it applies from their next invoice.
 */
export type GrantRejection =
  | "coupon_not_found"
  | "inactive"
  | "sold_out"
  | "already_used"
  | "no_subscription"
  | "expired"
  | "not_started"
  | "plan_not_eligible";

/** Admin-facing copy for why a grant can't go through. */
export const GRANT_REJECTION_MESSAGE: Record<GrantRejection, string> = {
  coupon_not_found: "That coupon no longer exists.",
  inactive:
    "That coupon is deactivated. Reactivate it on the Coupons page first, or pick an active one.",
  sold_out:
    "That coupon has hit its redemption limit. Raise the limit on the Coupons page, or pick another.",
  already_used:
    "This customer has already used that coupon — a code can only be redeemed once per account.",
  no_subscription:
    "This customer has no subscription yet, so there's nothing for a percentage discount to apply to. A bonus-minutes coupon would still work.",
  expired:
    "That coupon's redemption window has closed. Extend the date on the Coupons page, or confirm the override to grant it anyway.",
  not_started:
    "That coupon's redemption window hasn't opened yet. Change the start date on the Coupons page, or confirm the override to grant it early.",
  plan_not_eligible:
    "That coupon is limited to specific plans and this customer isn't on one of them. Change the plan restriction on the Coupons page, or confirm the override to grant it anyway.",
};

/**
 * Rules that govern who may redeem a coupon, as opposed to whether it can work
 * at all. An admin grant may step past these — comping a lapsed or off-plan
 * offer to a customer is a legitimate retention move — but never silently: the
 * grant is refused unless the caller explicitly overrides, and the override is
 * written to the audit log.
 *
 * (Contrast the hard blockers above: deactivated, sold out, already used, no
 * subscription. Those aren't policy, they'd produce a broken or double-counted
 * discount, so no override exists for them.)
 */
export type GrantRestriction = "expired" | "not_started" | "plan_not_eligible";

/** Wording shown next to the override confirmation. */
export const GRANT_RESTRICTION_WARNING: Record<GrantRestriction, string> = {
  expired: "This coupon has expired.",
  not_started: "This coupon's start date hasn't arrived yet.",
  plan_not_eligible: "This coupon is limited to other plans — this customer isn't on one of them.",
};

/** Which of those rules this grant would break, if any. */
export function grantRestrictions(
  coupon: { startsAt: Date | null; expiresAt: Date | null; planIds: string[] },
  profile: { subscriptionPlanId: string | null } | null,
  now = new Date(),
): GrantRestriction[] {
  const out: GrantRestriction[] = [];
  const window = redemptionWindow(coupon, now);
  if (window !== "open") out.push(window);
  if (
    coupon.planIds.length > 0 &&
    (!profile?.subscriptionPlanId || !coupon.planIds.includes(profile.subscriptionPlanId))
  ) {
    out.push("plan_not_eligible");
  }
  return out;
}

export async function grantCoupon(
  userId: string,
  couponId: string,
  adminUserId: string,
  opts: { override?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: GrantRejection }> {
  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!coupon) return { ok: false, reason: "coupon_not_found" };

  // A deactivated coupon is retired — granting one would quietly resurrect it
  // and leave the Coupons page claiming it's off while a customer runs on it.
  if (!coupon.active) return { ok: false, reason: "inactive" };


  const existing = await prisma.couponRedemption.findUnique({
    where: { couponId_userId: { couponId, userId } },
  });
  // A reservation is fair game to overwrite — an admin grant supersedes an
  // unfinished checkout. A completed redemption is not.
  if (existing && existing.status !== "pending") return { ok: false, reason: "already_used" };

  // A grant increments redeemedCount like any other redemption, so honour the
  // cap — otherwise the count sails past the limit and the page reports a
  // nonsense "6 redeemed of 5". The admin can raise the cap deliberately.
  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, reason: "sold_out" };
  }

  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { stripeSubscriptionId: true, subscriptionPlanId: true },
  });
  // A percentage discount needs a subscription to attach to. A bonus-minutes
  // coupon doesn't, so it can be granted to anyone.
  if (coupon.percentOff && !profile?.stripeSubscriptionId) {
    return { ok: false, reason: "no_subscription" };
  }

  // The redemption window and the plan restriction bind admins too. Not as hard
  // walls — comping a lapsed or off-plan offer is a real retention move — but
  // they can't be crossed by accident: the caller has to say so, and the
  // override lands in the audit log. Without this an admin could hand out a
  // STARTER-only campaign that ended months ago and nothing would say a word.
  const restrictions = grantRestrictions(coupon, profile);
  if (restrictions.length > 0 && !opts.override) {
    return { ok: false, reason: restrictions[0] };
  }

  // Same single transaction as activateRedemption, and for the same reason: a
  // grant racing a customer redemption (or another admin's grant) must not be
  // able to leave two rows live. updateMany also clears any pre-existing
  // collision rather than preserving it.
  const redemption = await prisma.$transaction(async (tx) => {
    await lockUserCouponState(tx, userId);
    await tx.couponRedemption.updateMany({
      where: { userId, status: "active" },
      data: { status: "revoked", endedAt: new Date() },
    });
    if (existing) await tx.couponRedemption.delete({ where: { id: existing.id } });
    const created = await tx.couponRedemption.create({
      data: {
        couponId,
        userId,
        status: "active",
        appliedAt: new Date(),
        grantedBy: adminUserId,
      },
    });
    await tx.coupon.update({
      where: { id: couponId },
      data: { redeemedCount: { increment: 1 } },
    });
    await tx.profile.update({
      where: { userId },
      data: { activeCouponRedemptionId: created.id },
    });
    return created;
  });

  // Not gated on `coupon.stripeCouponId` any more: granting a bonus-minutes-only
  // coupon over a live percentage one has to CLEAR that percentage, or the
  // customer keeps being billed less under a redemption that is no longer theirs
  // and that nothing will ever retire.
  await syncStripeDiscountTo(userId, profile?.stripeSubscriptionId ?? null, coupon);

  void recordPlanEvent({
    userId,
    type: "coupon_applied",
    note: `${couponAppliedNote(coupon)} (granted by an admin)`,
  });
  void redemption;
  return { ok: true };
}

/** One row in the admin's "grant a coupon" picker. */
export interface GrantableCoupon {
  id: string;
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  durationCycles: number;
  /** False → the picker disables it and shows `reason`. */
  eligible: boolean;
  reason: string | null;
  /** Grantable, but the admin should know something first. */
  warning: string | null;
  /** Breaks a rule an admin may step past — grantable only with an explicit
   *  override (expired / not started / wrong plan). */
  requiresOverride: boolean;
  restrictions: GrantRestriction[];
  /** The window date being stepped past (expiry, or a start that hasn't come). */
  windowEndsAt: string | null;
}

/**
 * Every active coupon, annotated with whether it can be granted to this
 * customer and why not.
 *
 * The picker never decides eligibility itself — it renders what this returns —
 * so the button the admin sees and the rule the server enforces can't drift
 * apart. `grantCoupon` re-checks everything regardless; this exists so the
 * admin learns the answer before clicking, not after.
 */
export async function grantableCoupons(userId: string): Promise<GrantableCoupon[]> {
  const [coupons, redemptions, profile] = await Promise.all([
    prisma.coupon.findMany({ where: { active: true }, orderBy: { createdAt: "desc" } }),
    prisma.couponRedemption.findMany({ where: { userId } }),
    prisma.profile.findUnique({
      where: { userId },
      select: { stripeSubscriptionId: true, subscriptionPlanId: true },
    }),
  ]);

  // Anything that isn't a bare reservation means this user is done with the code.
  const spentCouponIds = new Set(
    redemptions.filter((r) => r.status !== "pending").map((r) => r.couponId),
  );

  // One clock for the whole list, so two coupons expiring in the same second
  // can't be judged against different "now"s.
  const now = new Date();
  return coupons.map((c) => {
    let reason: string | null = null;
    if (spentCouponIds.has(c.id)) reason = GRANT_REJECTION_MESSAGE.already_used;
    else if (c.maxRedemptions != null && c.redeemedCount >= c.maxRedemptions)
      reason = GRANT_REJECTION_MESSAGE.sold_out;
    else if (c.percentOff && !profile?.stripeSubscriptionId)
      reason = GRANT_REJECTION_MESSAGE.no_subscription;

    // The date window and the plan restriction don't block a grant outright —
    // an admin is making a deliberate call about this one account — but they do
    // gate the button until it's confirmed. Listed here so the admin reads what
    // they're stepping past BEFORE clicking, not in an error afterwards.
    const restrictions = reason === null ? grantRestrictions(c, profile, now) : [];
    const warning =
      restrictions.map((r) => GRANT_RESTRICTION_WARNING[r]).join(" ") || null;

    return {
      id: c.id,
      code: c.code,
      displayName: c.displayName,
      percentOff: c.percentOff,
      bonusMinutes: c.bonusMinutes,
      durationCycles: c.durationCycles,
      eligible: reason === null,
      reason,
      warning,
      requiresOverride: restrictions.length > 0,
      restrictions,
      /** So the confirmation can name the date the admin is stepping past. */
      windowEndsAt: restrictions.includes("expired")
        ? (c.expiresAt?.toISOString() ?? null)
        : restrictions.includes("not_started")
          ? (c.startsAt?.toISOString() ?? null)
          : null,
    };
  });
}

/**
 * Plan minutes plus whatever the live discount adds.
 *
 * MUST be used to build the `includedMinutes` argument handed to
 * `applyActivePlanMinutes` — never added to the allowance afterwards. That
 * function is deliberately idempotent per period, so a separate top-up call
 * would double-grant on a webhook replay.
 */
export async function effectiveIncludedMinutes(
  userId: string,
  planMinutes: number,
): Promise<number> {
  // 0 means unlimited — there is no allowance for a bonus to add to.
  if (planMinutes <= 0) return planMinutes;
  const live = await getActiveRedemption(userId);
  const bonus = live?.coupon.bonusMinutes ?? 0;
  return planMinutes + (bonus > 0 ? bonus : 0);
}

/**
 * Safety net for the reconcile path: detach a Stripe discount that outlived the
 * cycle budget we granted it.
 *
 * Reached when a detach failed or a webhook never landed. Without it a missed
 * event would leave a `forever` coupon discounting the customer indefinitely.
 * Best-effort and fail-open, like `getSubscriptionAutoRenew` — a transient
 * Stripe error must never break reconcile.
 */
export async function healDiscountDrift(
  userId: string,
  subscriptionId: string,
): Promise<void> {
  try {
    if (!isStripeConfigured()) return;

    // CHEAP LOCAL GATE FIRST. This runs from reconcileSubscription, which the
    // `validateTrial` middleware calls on EVERY gated API request — so reaching
    // Stripe from here unconditionally would put a network round-trip on every
    // request every customer makes, coupons or not.
    //
    // Drift can only exist if this user once held a coupon that ENDED: a live
    // one is supposed to be attached, and someone who never had one can't have
    // one of ours stranded. That's an indexed lookup on [userId, status].
    const everEnded = await prisma.couponRedemption.findFirst({
      where: { userId, status: { in: ["exhausted", "revoked"] } },
      select: { id: true },
    });
    if (!everEnded) return;

    const live = await getActiveRedemption(userId);
    if (live) return; // a live discount is supposed to be attached

    const attached = await getSubscriptionDiscountCouponId(subscriptionId);
    if (!attached) return; // nothing attached — already consistent

    // Only remove a discount that is ours; a coupon applied by hand in the
    // Stripe dashboard is somebody's deliberate decision, not drift.
    const ours = await prisma.coupon.findFirst({
      where: { stripeCouponId: attached },
      select: { id: true },
    });
    if (!ours) return;

    await detachSubscriptionDiscount(subscriptionId);
    // A pending downgrade holds its own copy of the discount, so clearing the
    // subscription without it just defers the problem to the period boundary.
    await mirrorDiscountOntoSchedule(userId, null);
  } catch {
    /* fail open — reconcile must never break on discount tidy-up */
  }
}

/**
 * Attach a coupon's discount to a live subscription (admin grant, where the
 * subscription already exists). Checkout instead passes the coupon id straight
 * into `createTrialSubscription`, so the very first invoice is discounted.
 */
export async function applyDiscountToSubscription(
  subscriptionId: string,
  coupon: Coupon,
): Promise<void> {
  if (!coupon.stripeCouponId || !isStripeConfigured()) return;
  await attachSubscriptionDiscount(subscriptionId, coupon.stripeCouponId);
}

/**
 * Mirror a coupon to Stripe — the same create/replace pattern the plan sync
 * uses, since Stripe coupons are immutable once created.
 *
 * A bonus-minutes-only coupon has no Stripe side at all: it never discounts
 * money, so there is nothing for Stripe to compute.
 */
export async function syncStripeCoupon(coupon: {
  code: string;
  displayName: string;
  percentOff: number | null;
  durationCycles: number;
  stripeCouponId: string | null;
}): Promise<{ stripeCouponId: string | null }> {
  if (!coupon.percentOff) {
    // Dropped the percentage (or never had one) → retire any Stripe object.
    if (coupon.stripeCouponId) await deleteStripeCoupon(coupon.stripeCouponId);
    return { stripeCouponId: null };
  }
  if (!isStripeConfigured()) return { stripeCouponId: coupon.stripeCouponId };
  if (coupon.stripeCouponId) return { stripeCouponId: coupon.stripeCouponId };

  const duration: StripeCouponDuration = coupon.durationCycles === 1 ? "once" : "forever";
  const stripeCouponId = await createStripeCoupon({
    name: `${coupon.displayName} (${coupon.code})`,
    percentOff: coupon.percentOff,
    duration,
  });
  return { stripeCouponId };
}

/**
 * Delete `pending` reservations older than the TTL, releasing their supply slots.
 *
 * They are DELETED, not marked: a leftover row would trip the unique
 * (couponId, userId) index and lock the user out of a code they abandoned at
 * checkout and never actually used. Returns how many were released.
 */
export async function sweepStalePendingRedemptions(): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_RESERVATION_TTL_MS);
  const { count } = await prisma.couponRedemption.deleteMany({
    where: { status: "pending", reservedAt: { lte: cutoff } },
  });
  return count;
}
