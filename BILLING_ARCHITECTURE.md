# Subscription & Billing Architecture

Reference for hello22.ai's multi-tenant subscription billing — the **plans / features /
upgrade-downgrade / legacy-plan / renewal** model as shipped. Pairs with the lifecycle notes in
[`CLAUDE.md`](CLAUDE.md) (which is the living source of truth — update it on any change).

> **No add-ons.** Add-ons were removed (migration `0007_plan_features_drop_addons` drops the
> `Addon`/`UserAddon` tables). Everything a tier offers — call minutes and features like SMS &
> WhatsApp — is bundled into the **plan** itself. There is no separate purchasable product.

## Goals

1. Users self-serve **after** onboarding: see their current plan + usage, **upgrade**, and
   **downgrade** — all from the dashboard, in the existing theme.
2. Admins manage plans safely: **activate/deactivate any time**, edit safe fields, but **never break
   existing subscribers**. A plan that is **in use cannot be deleted or re-priced**; deactivating it
   makes it **legacy** (kept for current users, hidden from new ones).
3. Stripe is the billing source of truth: **proration on upgrade**, **scheduled downgrade at period
   end**, and **auto-renewal on whichever limit hits first** (included minutes OR billing date).
4. Total transparency: the user always sees what they have, how much is left, what they'll pay, the
   proration discount, when changes take effect, and **that a renewal can fire early on minutes**.

## Decisions (locked)

- **Features live on the plan**: `SubscriptionPlan.smsEnabled` / `whatsappEnabled` / `customCrmEnabled` are real
  entitlement gates (see "Feature gating"). `features` (Json `string[]`) is display-only marketing
  bullets. Higher tiers = more minutes and/or more feature flags on.
- **Renewal = first limit wins**: an `active` plan renews when its `includedMinutes` are exhausted
  **or** when its billing date arrives — whichever is first. The minutes path is an *early* renewal
  (a fresh full charge now, clock restarts); the date path is Stripe's native cycle. A user is never
  blocked on minutes while their card works — only a **declined** renewal → `past_due`/blocked.
- **Plan edit while in-use**: only safe fields (`displayName`, `description`, `features`,
  `smsEnabled`, `whatsappEnabled`, `customCrmEnabled`, `sortOrder`, `recommended`). `priceCents`/`interval`/
  `includedMinutes` are **locked** — change pricing by deactivating (→ legacy) and creating a new plan.
- **Upgrade**: immediate. Credit for unused minutes = `(remainingMin / allocatedMin) × currentPrice`.
  Amount due = `newPrice − credit` (never < 0). Preview shown (with loading) before charge. The new
  plan grants its **full** allowance — the per-cycle usage counter is reset (`resetUsage`), since the
  credit already settled the unused old minutes and the used ones were paid on the old plan; they must
  not carry over and shrink the upgraded allowance.
- **Downgrade**: takes effect at `currentPeriodEnd`. Current plan stays active until then; next cycle
  bills the lower plan. No immediate charge/refund.
- **Legacy plan**: `active = false` **and** has ≥1 subscriber. Hidden from pickers, shown to its
  current users with a "Legacy" badge + a nudge toward active plans.

## Data model (Prisma — [`server/prisma/schema.prisma`](server/prisma/schema.prisma))

`SubscriptionPlan` — the single billable product:
- `includedMinutes Int` — call minutes per cycle (`0` = unlimited).
- `smsEnabled Boolean` / `whatsappEnabled Boolean` / `customCrmEnabled Boolean` — feature entitlement flags
  (`customCrmEnabled` gates Custom CRM webhook lead delivery: provider selection, test sends, and live delivery).
- `features Json` (`string[]`) — marketing bullets, display only.
- `priceCents` / `currency` / `interval` / `stripeProductId` / `stripePriceId` / `active` /
  `sortOrder` / `recommended`. "Legacy" is **derived** (`!active && subscriberCount > 0`).

`Profile` — carries trial + per-cycle plan counters: `trialSecondsUsed`, `planSecondsUsed`,
`planMinutesAllocated`, `currentPeriodEnd`, `subscriptionStatus`, `stripe*Id`, `cardFingerprint`,
plus pending-downgrade fields (`scheduledPlanId`, `scheduledPlanEffectiveAt`, `stripeScheduleId`).

## Entitlement ([`server/src/services/trial.ts`](server/src/services/trial.ts))

`getEntitlement(userId)` is the source of truth for "can this user run AI calls, and how many minutes
remain". One bucket — the plan/trial allowance (no add-on bucket):
- `minutesAllocated` = `planMinutesAllocated` (active) or trial allowance; `minutesUsed` from the
  per-cycle seconds counter; `minutesRemaining` = the difference.
- Trial blocks on minutes-exhausted (precedence) or date passed. Active plan reports
  `expired_minutes` when the cycle's minutes are spent — but that state is **transient**: the
  post-call settle renews the cycle (see below) rather than leaving the user blocked.
- `recordUsage` increments the active counter atomically, rounding each call up to a whole billable
  minute (`billableSeconds`); the real duration is still stored on the `CallLog` for display.

**Feature gating.** `getPlanFeatures(userId)` → `{ sms, whatsapp }` (admin = all on; a customer gets
their plan's flags while `trialing`/`active`; blocked/none → all off). Enforced at:
- Post-call owner **SMS** + **WhatsApp** summaries — [`calls.routes.ts`](server/src/routes/calls.routes.ts).
- Inbound **WhatsApp** AI auto-reply — [`whatsapp.routes.ts`](server/src/routes/whatsapp.routes.ts).

## Renewal lifecycle

`settleAfterCall(userId)` ([`provisioning.ts`](server/src/services/provisioning.ts)) runs after every
recorded call → `reconcileSubscription` ([`trial.ts`](server/src/services/trial.ts)):
- **Trialing** whose trial just lapsed (minutes or date) → end the Stripe trial now → charge the
  card saved at onboarding → flip to `active` + `applyActivePlanMinutes` (failed charge → `past_due`).
- **Active** whose `includedMinutes` are exhausted → `renewActivePlanIfExhausted` →
  `renewSubscriptionNow` (Stripe `billing_cycle_anchor: "now"`, `proration_behavior: "none"`,
  `payment_behavior: "error_if_incomplete"`) → charge a fresh full period, reset the minute counter,
  restart the clock; notify the user. Declined → `past_due`/blocked.
- **Date-based** renewal stays Stripe's native cycle: the `customer.subscription.*` webhook
  ([`billing.routes.ts`](server/src/routes/billing.routes.ts)) calls `applyActivePlanMinutes` on
  `active`. `applyActivePlanMinutes` is idempotent per period (only resets when `currentPeriodEnd`
  advances), so the early-renewal path and the webhook don't double-reset.
- **Cancel = auto-renew off, from either surface.** `Profile.autoRenew` mirrors Stripe's
  `cancel_at_period_end`. The in-app `/auto-renew` toggle writes both DB + Stripe. A cancel done in
  the **hosted portal** ("Manage billing") only touches Stripe, so the `customer.subscription.*`
  webhook syncs `autoRenew = !cancel_at_period_end` back onto the profile. As a safety net for a
  missed/lagging webhook (it never reaches a local dev server), `renewActivePlanIfExhausted` reads
  the **live** cancel state (`getSubscriptionAutoRenew`) before an early minutes-exhausted renewal —
  a cancelled subscription is never auto-recharged, and the stale flag is healed off. The live read
  fails open (a transient Stripe error won't block a legitimate renewal).

## Backend — endpoints ([`billing.routes.ts`](server/src/routes/billing.routes.ts))

**User (requireAuth):**
- `GET  /api/billing/plans` — active plans (pickers).
- `GET  /api/billing/trial-info` — global trial `{ days, minutes }` for the subscribe/go-live pages.
- `POST /api/billing/subscribe` `{ planId }` — start the trial subscription (plan-only, card saved
  via the returned SetupIntent client secret); auto-provisions the agent.
- `POST /api/billing/confirm-card` — one-card-per-account dedup by Stripe fingerprint.
- `GET  /api/billing/subscription` — current plan detail incl. `smsEnabled`/`whatsappEnabled`,
  `scheduledPlan` (pending downgrade), `currentPeriodEnd`, `legacy`.
- `POST /api/billing/change-plan/preview` `{ planId }` → `{ direction, currentPlan, newPlan,
  minutesAllocated, minutesRemaining, creditCents, amountDueCents, effectiveAt }`. Pure calc, no charge.
- `POST /api/billing/change-plan` `{ planId }` — upgrade: swap Stripe item now
  (`proration_behavior: 'none'`) + charge `amountDueCents` as a one-time invoice + grant new minutes.
  Downgrade: subscription **schedule** swaps price at period end; record `scheduledPlanId`.
- `POST /api/billing/change-plan/cancel-downgrade` — release a pending downgrade.
- `GET  /api/billing/invoices` / `GET /api/billing/portal` — Stripe invoices + hosted portal.

**Admin ([`admin.routes.ts`](server/src/routes/admin.routes.ts), guarded by in-use checks):**
- `GET    /api/admin/plans` — include `subscriberCount` + `legacy`.
- `POST   /api/admin/plans` / `PATCH /api/admin/plans/:id` — `planInput` carries `smsEnabled`/
  `whatsappEnabled`; if `subscriberCount > 0`, reject `priceCents`/`interval`/`includedMinutes`
  changes (allow safe fields).
- `DELETE /api/admin/plans/:id` — if `subscriberCount > 0`, reject (deactivate → legacy instead).

## Stripe service ([`server/src/services/stripe.ts`](server/src/services/stripe.ts))

- `createTrialSubscription` — customer + trial sub (card saved on the SetupIntent).
- `swapSubscriptionPriceNow(subId, priceId)` — immediate item-price swap, `proration_behavior: 'none'`
  (we compute our own minutes-based delta and charge it separately).
- `renewSubscriptionNow(subId)` — early renewal: `billing_cycle_anchor: 'now'`, no proration,
  `error_if_incomplete`. ⚠ **Verify against Stripe test mode** that this charges a full fresh period
  immediately (no unused-time credit) and restarts the cycle; if not, switch to
  `proration_behavior: 'always_invoice'` (note: that would credit unused time → partial charge).
- `chargeOneTime(customerId, amountCents, desc)` — standalone invoice for the upgrade delta.
- `scheduleDowngrade` / `releaseSchedule` — subscription schedules for downgrades.
- Product/price sync for admin-created plans (prices immutable → new price + archive old).

## Frontend

- **Plans & Billing** [`src/pages/billing/PlansPage.tsx`](src/pages/billing/PlansPage.tsx) (`/dashboard/plans`):
  prominent **"renews on whichever limit comes first — minutes OR days"** callout; current-plan card
  with minutes used/left, renewal date, SMS/WhatsApp badges, pending-downgrade banner; plan grid with
  per-tier feature badges + Upgrade/Downgrade; change-plan modal with proration preview.
- **Subscribe** [`src/pages/subscribe/SubscribePage.tsx`](src/pages/subscribe/SubscribePage.tsx) +
  go-live step: plan-only picker, trial terms, "$0 due today / billed when trial ends".
- **Admin plan form** [`src/pages/admin/AdminPlansPage.tsx`](src/pages/admin/AdminPlansPage.tsx): SMS +
  WhatsApp toggles alongside Active/Recommended.
- **API/types** [`src/lib/api.ts`](src/lib/api.ts): `SubscriptionPlan`/`PlanInput`/`SubscriptionDetail`
  carry `smsEnabled`/`whatsappEnabled`; no addon types.

## Coupons ([`server/src/services/coupons.ts`](server/src/services/coupons.ts))

Admin-created discount codes, redeemed at checkout or granted to an account. Two kinds of value,
combinable on one coupon: **`percentOff`** (mirrored to a Stripe coupon, which does the arithmetic
on subscription invoices) and **`bonusMinutes`** (ours alone — extra call minutes per cycle, never
sent to Stripe).

**Three lifetimes, deliberately separate.** Conflating them is how coupon systems go wrong:

| | Lives until |
|---|---|
| The **coupon** (shared code) | `expiresAt` passes, `maxRedemptions` is hit, or an admin deactivates it. One user redeeming it only increments `redeemedCount`. |
| A user's **redemption** | Never. `@@unique([couponId, userId])` is what stops that user redeeming the same code twice — enforced in the DB, so a race or double-submit can't slip past it. |
| The **discount** | `durationCycles` billing cycles, then it detaches. |

A spent redemption is KEPT as `exhausted` precisely because it is the record that blocks re-entry.
A stale `pending` reservation is **deleted** by the hourly sweep, never marked — a leftover row
would trip the unique index and lock the user out of a code they abandoned and never used.

**Duration is counted in billing cycles by us, not Stripe's calendar months.** This is the crux:
`renewActivePlanIfExhausted` renews *early* whenever a user burns their minutes, so a heavy user can
consume several cycles inside one calendar month and Stripe's `duration_in_months` would discount
every one of them. So:
- `durationCycles === 1` → Stripe coupon `duration: "once"`. Stripe retires it itself; nothing can leak.
- `durationCycles > 1` → Stripe coupon `duration: "forever"`, and **we** detach it when the budget is spent.

**`consumeCycle` runs AFTER the charge and AFTER the minute grant** for that charge — at every charge
path (checkout, trial conversion, date renewal, early renewal, manual `/renew`). The cycle being paid
for is one the coupon still covers, so its discount and bonus minutes both belong to it; consuming
first would retire a single-cycle coupon before granting the very bonus minutes it promised. It's
idempotent per period via `lastCountedPeriodEnd`, because an early renewal counts a cycle *and* fires
a `customer.subscription.updated` webhook that would otherwise count it again — halving the discount.

**Bonus minutes are folded into the `includedMinutes` argument** passed to `applyActivePlanMinutes`
(via `effectiveIncludedMinutes`), never added afterwards — that function is idempotent per period, so
a separate top-up would double-grant on a webhook replay.

**Safety net.** `reconcileSubscription` calls `healDiscountDrift`, which detaches one of *our*
discounts still attached with no live redemption (a failed detach, a webhook that never landed). It
leaves coupons applied by hand in the Stripe dashboard alone.

**Deliberate non-goals**: coupons never discount the **upgrade delta** (`chargeOneTime` is a
standalone invoice we price ourselves, not a subscription invoice — the upgrade modal says so
explicitly), and there is no code entry on the blocked-user `/renew` path.

**Reseller commission** is unchanged: `accrueCommissionForInvoice` uses `invoice.amount_paid`, so a
discounted invoice pays the reseller proportionally less. That's the intended split of promotion cost.

**Redemption counts only when money moves** — `/subscribe` reserves a `pending` slot, `/confirm-card`
promotes it to `active`. Abandoned checkouts are swept after 30 minutes and their slot returns to the
campaign, so the cap check is `redeemedCount + live pending < maxRedemptions`.

**Admin revoke** takes a `releaseSlot` flag: off (default) keeps the row so the code stays spent for
that customer; on deletes it and refunds the slot, letting them redeem again — the undo for a coupon
granted by mistake.

### Bonus minutes are per cycle, not per plan change

`effectiveIncludedMinutes` folds a coupon's bonus into the allowance at every path that opens a
billing cycle: checkout, trial conversion, Stripe's date renewal, our early minutes-exhausted
renewal, and the manual renew.

A mid-cycle **upgrade is not one of them** — the delta is a standalone invoice, not a subscription
cycle, which is also why nothing calls `consumeCycle` there. So `/change-plan` grants
`target.includedMinutes` alone. Re-adding the bonus on top of the usage reset would let a customer
upgrade, spend the bonus, upgrade again and collect it a second time inside one cycle. The
customer isn't short-changed: that cycle's bonus was already granted at the boundary, the unused
part of the allowance comes back as proration credit, and the next real renewal grants it again
while cycles remain.

### Downgrades keep the discount

A queued downgrade is a Stripe subscription schedule, and writing its phases replaces them
wholesale. Stripe's rule for a phase is *"if `discounts` is not specified, inherit from the
subscription's **customer**"* — our coupons sit on the subscription, not the customer, so phases
written without it strip the discount the moment the schedule takes over. Nothing errors; the
customer simply starts paying full price with cycles still owed.

So `scheduleDowngrade` reads the live discount and restates it on **both** phases — the cheaper one
too, because a coupon is a number of billing *cycles*, not a plan.

Behind that, `consumeCycle` re-attaches a discount that has gone missing while cycles remain
(`ensureDiscountAttached`). It runs at the cycle boundary, NOT on the reconcile path that every
gated API request goes through — a Stripe call per request would be a heavy price for a rare
repair. `once` coupons are excluded: Stripe removes those itself after the first invoice, so
"missing" is the correct state.

> ⚠ **Still worth one pass in Stripe test mode:** unit tests pin what we *send* to Stripe; only a
> real downgrade proves what Stripe *does* with it across the phase boundary.

## Edge cases handled

- Re-pricing/deleting an in-use plan → blocked (legacy path).
- Downgrade then change-of-mind → cancel-downgrade.
- Upgrade credit larger than new price → amount due floored at 0 (no negative charge).
- Minutes exhausted mid-cycle → early renewal (full charge + reset), not a block; declined card →
  `past_due`. A fast user can therefore be charged more than once per nominal period (surfaced in UI).
- Trial users upgrading/downgrading → applies at conversion; preview reflects trial minutes.
- Unlimited plans (`includedMinutes = 0`) → no minute math, no early renewal, proration credit = 0.
  A coupon's bonus minutes are a no-op here (there is no allowance to add to); its percentage still applies.
- Coupon code colliding with a reseller `referralCode` → rejected at creation; from the customer's
  point of view both are "a code you were given", so a collision would be genuinely ambiguous.
- Coupon that anyone has been shown the terms of → code/discount/duration locked and delete blocked
  (deactivate instead), mirroring the in-use plan rule. "Shown" means a completed redemption **or a
  checkout in progress**: a customer on the card step has already seen these terms, so moving them
  underneath is the same wrong as rewriting a finished redemption. Stale reservations don't lock
  anything, so an abandoned checkout can't freeze admin edits.
- Editing an unlocked coupon's percentage/duration → the Stripe coupon is **replaced**, not updated.
  Stripe coupons are immutable, so an in-place edit would leave Stripe billing the old rate.
