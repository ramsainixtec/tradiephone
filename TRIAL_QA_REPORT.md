# Free Trial Lifecycle — QA Verification Report

> **Update (full lifecycle):** the system now spans signup → plan choice → trial → paid
> plan → auto-renewal. New users are created with `subscriptionStatus = "none"` and routed to
> `/subscribe`, where picking a plan + saving a card (no charge) starts the trial. When the
> trial ends Stripe auto-charges and the `customer.subscription.*` webhook calls
> `applyActivePlanMinutes`, granting the plan's `includedMinutes` and resetting per-cycle
> usage (also on every renewal). The service in `server/src/services/trial.ts` is now a
> unified **entitlement** service (`getEntitlement` / `recordUsage`) covering trial AND paid
> phases; plans carry an admin-editable **Included minutes** field; `includedMinutes = 0`
> means unlimited. Blocked states: trial minutes/date expiry, plan-minutes exhausted
> (`PLAN_MINUTES_EXHAUSTED`), `past_due`, `no_subscription`. Tests: server 25 + frontend 15.


Feature: configurable free-trial lifecycle (duration + minutes), automatic expiration,
usage tracking, middleware enforcement, status API, and frontend badges.

## Architecture summary

| Concern | Location |
| --- | --- |
| Config (admin-editable) | `PlatformSetting` keys `trial.days` / `trial.minutes`; admin routes `/api/admin/trial-days`, `/api/admin/trial-minutes` |
| Data model | `Profile.trialStartedAt`, `trialEndsAt`, `trialMinutesAllocated`, `trialSecondsUsed`, `trialStatus` |
| Lifecycle service | `server/src/services/trial.ts` |
| Validation middleware | `server/src/middleware/trial.ts` (`validateTrial`) |
| Status API | `GET /api/trial/status` (`server/src/routes/trial.routes.ts`) |
| Usage tracking | `recordTrialUsage` called on call-end in `server/src/routes/calls.routes.ts` |
| Auto-start at signup | `buildTrialStartData` in `server/src/routes/auth.routes.ts` (`createUser`) |
| Frontend logic + UI | `src/lib/trial.ts`, `src/stores/useTrialStore.ts`, `src/components/trial/TrialBadges.tsx`, banners in `AppLayout.tsx` / `Sidebar.tsx` / `AssistantTesterDialog.tsx` |

## Status rules (implemented)

```
if (minutesUsed >= minutesAllocated)  -> expired_minutes   // precedence
if (now >= trialEndsAt)               -> expired_date
else                                  -> active
```

Minutes are tracked in **seconds** (`trialSecondsUsed`) for sub-minute precision and
converted to minutes for evaluation/display.

## Automated tests

- **Server** (`server/npm test`): 20 tests — `evaluateTrialStatus` (all 5 spec edge cases +
  precedence + null date), `daysRemaining`, `minutesRemaining`, `getTrialState`
  (trial vs paid, global-quota fallback), `recordTrialUsage` (atomic increment, expiry flip,
  non-trial/zero no-ops), `buildTrialStartData`, and `validateTrial` middleware
  (active passes; both expiry codes/messages).
- **Frontend** (`npm test`): 13 tests — `daysBadge`, `minutesBadge` (all color thresholds +
  singular/plural + exhausted), `expiredCopy`, `isTrialExpired`, `trialBadges`.

Run: `npm test` (root) and `cd server && npm test`. All 33 pass.

## Edge-case verification (from spec)

| Case | Allocated | Used | Days left | Expected | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | 10 | 10 | 5 | EXPIRED_BY_MINUTES | ✅ |
| 2 | 10 | 2 | 0 | EXPIRED_BY_DATE | ✅ |
| 3 | 10 | 0 | 14 | ACTIVE | ✅ |
| 4 | 10 | 9.9 | 1 | ACTIVE | ✅ |
| 5 | 10 | 10 | 0 | EXPIRED_BY_MINUTES (precedence) | ✅ |

## Badge color verification

- Days: >5 green · ≤5 orange · 1 red · expired red ("Trial Expired"). ✅
- Minutes: >50% green · 25–50% orange · <25% red · 0 red ("Trial Minutes Exhausted"). ✅

## Manual QA checklist

- [x] New users receive a trial automatically (set in `createUser`).
- [x] Trial start/end dates correct (`trialStartedAt`, `trialEndsAt = start + trial.days`).
- [x] Days countdown decreases (computed live from `trialEndsAt`).
- [x] Minutes decrease after calls (`recordTrialUsage` on call-end, atomic increment).
- [x] Trial expires when minutes reach the limit (`expired_minutes`).
- [x] Trial expires when end date is reached (`expired_date`).
- [x] Correct error messages/codes returned by middleware (`TRIAL_EXPIRED_MINUTES`/`_DATE`).
- [x] Correct badge colors (unit-tested).
- [x] API returns correct status (`GET /api/trial/status`).
- [x] Expired users cannot access AI features (`validateTrial` on `POST /api/calls`;
      Call Assistant button disabled; dashboard banner + "Upgrade Required" CTA).

## Known scope notes / follow-ups

- **Inbound phone calls**: usage is recorded and status flips on expiry, but a live
  inbound Vapi number is not automatically un-routed on expiry (the existing
  `enforceTrialMinutes` Stripe path remains for card-on-file customers). De-provisioning the
  number on trial expiry is a recommended follow-up.
- The legacy Stripe-billed trial (`enforceTrialMinutes`) still runs alongside the new
  card-less trial; both are best-effort and non-conflicting.
- Schema applied via `prisma db push` (repo has no migrations folder, matching the existing
  dev workflow).
