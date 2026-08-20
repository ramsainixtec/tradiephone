import { prisma } from "../prisma.js";
import { badRequest, notFound, notImplemented, HttpError } from "../lib/http.js";
import { getEffective, integrationsStatus, setSettingValue } from "./settings.js";
import {
  isTwilioConfigured,
  listTwilioNumbersDetailed,
  searchAvailableNumbers,
  searchNumbersByPrefix,
  purchaseNumber,
  sendSms,
  monthlyPriceCentsFor,
  describeSmsError,
  fetchSmsCapability,
} from "./sms.js";
import { importTwilioNumber, releaseVapiNumber, upsertAssistant } from "./vapi.js";
import type { AgentConfig } from "../lib/agentConfig.js";

/* ------------------------------------------------------------------ *
 *  Admin phone-number management. The PhoneNumber table is the source
 *  of truth for the panel; `Profile.receptionistNumber` is kept in sync
 *  on (re)assignment so the customer dashboard + provisioning still work.
 * ------------------------------------------------------------------ */

const DEFAULT_MONTHLY_CENTS = 5000;

const normalize = (s: string | null | undefined): string => (s ?? "").replace(/[^\d+]/g, "");

/** Customer-facing agent label, mirroring the Vapi assistant naming. */
function agentLabel(config: AgentConfig | null | undefined): string {
  const business = config?.identity?.businessName?.trim();
  if (business) return `${business} Receptionist`;
  return config?.identity?.assistantName?.trim() || "Receptionist";
}

export interface PoolNumberDto {
  id: string;
  number: string;
  status: string;
  poolStatus: string;
  purchasePriceCents: number;
  monthlyPriceCents: number;
  addedAt: string;
}
export interface UserNumberDto extends PoolNumberDto {
  agentName: string;
  agentProvider: string;
  agentId: string | null;
  userEmail: string;
}
export interface OverviewDto {
  pool: PoolNumberDto[];
  userNumbers: UserNumberDto[];
  smsSender: string | null;
}
export interface AgentDto {
  id: string;
  name: string;
  provider: string;
  userEmail: string;
  autoRoutes: boolean;
}
export interface ImportableDto {
  sid: string;
  number: string;
  monthlyPriceCents: number;
}

/** Split every tracked number into System Pool vs User Numbers, carving out the
 *  current SMS sender (it lives only in its own card). */
export async function getOverview(): Promise<OverviewDto> {
  const sender = normalize(getEffective("twilio.fromNumber")) || null;
  const rows = await prisma.phoneNumber.findMany({
    orderBy: { createdAt: "desc" },
    include: { user: { select: { email: true, conversion: true } } },
  });

  const pool: PoolNumberDto[] = [];
  const userNumbers: UserNumberDto[] = [];
  for (const r of rows) {
    if (sender && normalize(r.number) === sender) continue; // shown in the SMS card
    // Live Twilio rate for this number's country (cached per country for 10 min).
    // A recorded purchase amount wins; otherwise show what Twilio actually
    // charges for the number today, falling back to the stored values only
    // when pricing can't be fetched.
    const livePriceCents = await monthlyPriceCentsFor(r.number);
    const base: PoolNumberDto = {
      id: r.id,
      number: r.number,
      status: r.status,
      poolStatus: r.poolStatus,
      purchasePriceCents:
        r.purchasePriceCents > 0 ? r.purchasePriceCents : (livePriceCents ?? r.purchasePriceCents),
      monthlyPriceCents: livePriceCents ?? r.monthlyPriceCents,
      addedAt: r.createdAt.toISOString(),
    };
    if (r.userId && r.user) {
      const conv = r.user.conversion;
      userNumbers.push({
        ...base,
        agentName: agentLabel(conv?.agentConfig as unknown as AgentConfig),
        agentProvider: "Voice Agent",
        agentId: r.assistantId ?? conv?.vapiAssistantId ?? null,
        userEmail: r.user.email,
      });
    } else {
      pool.push(base);
    }
  }
  return { pool, userNumbers, smsSender: sender ? getEffective("twilio.fromNumber") : null };
}

/** Every agent a number can be assigned to (one per customer conversion). */
export async function listAgents(): Promise<AgentDto[]> {
  const convs = await prisma.conversion.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
  });
  return convs.map((c) => ({
    id: c.id,
    name: agentLabel(c.agentConfig as unknown as AgentConfig),
    provider: "Voice Agent",
    userEmail: c.user.email,
    autoRoutes: Boolean(c.vapiAssistantId),
  }));
}

/** Owned Twilio numbers not yet tracked in the pool — importable as-is. */
export async function twilioAvailable(): Promise<ImportableDto[]> {
  if (!isTwilioConfigured()) return [];
  const [owned, rows] = await Promise.all([
    listTwilioNumbersDetailed(),
    prisma.phoneNumber.findMany({ select: { number: true } }),
  ]);
  const have = new Set(rows.map((r) => normalize(r.number)));
  const importable = owned.filter((o) => !have.has(normalize(o.number)));
  // Show the REAL Twilio monthly rate for each number (cached per country), so the
  // admin sees what they're actually paying — not a flat placeholder. Falls back to
  // the default only when live pricing can't be fetched.
  return Promise.all(
    importable.map(async (o) => ({
      sid: o.sid,
      number: o.number,
      monthlyPriceCents: (await monthlyPriceCentsFor(o.number)) ?? DEFAULT_MONTHLY_CENTS,
    })),
  );
}

/** Search Twilio's catalog for purchasable numbers. A `prefix` (e.g. AU 02/03/04)
 *  narrows to matching numbers; otherwise filters by area code / contains / type. */
export async function twilioSearch(opts: {
  country?: string;
  areaCode?: string;
  contains?: string;
  type?: "local" | "mobile";
  prefix?: string;
}): Promise<ImportableDto[]> {
  if (!isTwilioConfigured()) throw notImplemented("Twilio is not configured");
  const country = (opts.country || "US").toUpperCase();
  const numbers = opts.prefix
    ? await searchNumbersByPrefix(country, opts.prefix, 10)
    : (
        await searchAvailableNumbers({
          country,
          areaCode: opts.areaCode,
          contains: opts.contains,
          type: opts.type,
          limit: 10,
        })
      ).map((f) => f.number);
  // No SID until purchased — the number itself keys the buy. Show the real Twilio
  // rate for each (cached per country), falling back to the default when pricing
  // can't be fetched.
  return Promise.all(
    numbers.map(async (n) => ({
      sid: n,
      number: n,
      monthlyPriceCents: (await monthlyPriceCentsFor(n)) ?? DEFAULT_MONTHLY_CENTS,
    })),
  );
}

/** Add a number to the system pool — either importing one already owned
 *  (purchase=false) or buying a new one from Twilio (purchase=true). */
export async function addSystem(opts: {
  number: string;
  sid?: string | null;
  purchase?: boolean;
}): Promise<PoolNumberDto> {
  if (!isTwilioConfigured()) throw notImplemented("Twilio is not configured");
  const number = opts.number.trim();
  if (!/^\+?\d{6,15}$/.test(normalize(number))) throw badRequest("That doesn't look like a valid phone number");

  const existing = await prisma.phoneNumber.findUnique({ where: { number } });
  if (existing) throw badRequest("That number is already tracked in the pool");

  let twilioSid: string | null = opts.sid ?? null;
  // Whether the number can send SMS, per Twilio. null = we couldn't confirm, and
  // resolveSmsSender treats that as "no" rather than risking a silent failure.
  let smsCapable: boolean | null = null;
  if (opts.purchase) {
    twilioSid = await purchaseNumber(number);
  } else if (!twilioSid) {
    const owned = await listTwilioNumbersDetailed();
    const match = owned.find((o) => normalize(o.number) === normalize(number));
    twilioSid = match?.sid ?? null;
    smsCapable = match?.smsCapable ?? null;
  }
  // Resolve capability from the SID when the lookup above didn't already answer
  // it. Best-effort by design — a failed check stores null, and the admin's
  // Re-sync fills it in later.
  if (smsCapable === null && twilioSid) smsCapable = await fetchSmsCapability(twilioSid);

  // Use the real Twilio monthly rate for this number's country, falling back to
  // the flat default only if pricing can't be fetched.
  const monthlyPriceCents = (await monthlyPriceCentsFor(number)) ?? DEFAULT_MONTHLY_CENTS;
  const row = await prisma.phoneNumber.create({
    data: {
      number,
      provider: "twilio",
      twilioSid,
      smsCapable,
      status: "active",
      poolStatus: "AVAILABLE",
      // Buying a number costs the first month's rate up front; imports cost nothing.
      purchasePriceCents: opts.purchase ? monthlyPriceCents : 0,
      monthlyPriceCents,
    },
  });
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    poolStatus: row.poolStatus,
    purchasePriceCents: row.purchasePriceCents,
    monthlyPriceCents: row.monthlyPriceCents,
    addedAt: row.createdAt.toISOString(),
  };
}

/** Move a number to the system pool (conversionId null) or assign it to an
 *  agent — rewiring Vapi routing and keeping the owner's profile in sync. */
export async function reassign(id: string, conversionId: string | null): Promise<void> {
  const row = await prisma.phoneNumber.findUnique({ where: { id } });
  if (!row) throw notFound("Phone number not found");

  // Release the number's current Vapi routing before re-homing it.
  if (integrationsStatus().vapi) await releaseVapiNumber(row.number);

  if (!conversionId) {
    await prisma.$transaction(async (tx) => {
      if (row.userId) {
        await tx.profile.updateMany({
          where: { userId: row.userId, receptionistNumber: row.number },
          data: { receptionistNumber: "", numberActivated: false },
        });
      }
      await tx.phoneNumber.update({
        where: { id },
        data: { userId: null, assistantId: null, poolStatus: "AVAILABLE", status: "active" },
      });
    });
    return;
  }

  const conv = await prisma.conversion.findUnique({ where: { id: conversionId }, include: { user: true } });
  if (!conv) throw notFound("Agent not found");

  // An agent holds one number at a time — if it already has a different number,
  // changing it frees the old one: release its Vapi routing + return it to the pool.
  const previous = await prisma.phoneNumber.findMany({ where: { userId: conv.userId, id: { not: id } } });

  // Resolve the agent's LIVE Vapi assistant, then route on Vapi first — abort
  // before any DB write if it fails, so a number is never marked assigned without
  // live routing. upsertAssistant verifies the stored id and recreates it if it was
  // deleted on Vapi, so the number always binds to a real, selectable assistant
  // (not a stale UUID). The fresh id is persisted to the conversion + the row.
  let routedAssistantId = conv.vapiAssistantId;
  if (integrationsStatus().vapi) {
    try {
      for (const p of previous) await releaseVapiNumber(p.number);
      routedAssistantId = await upsertAssistant(conv.agentConfig as unknown as AgentConfig, conv.vapiAssistantId, { ownerId: conv.userId });
      if (routedAssistantId !== conv.vapiAssistantId) {
        await prisma.conversion.update({ where: { id: conv.id }, data: { vapiAssistantId: routedAssistantId } });
      }
      await importTwilioNumber({ number: row.number, assistantId: routedAssistantId });
    } catch (e) {
      // Preserve a clear, actionable error (e.g. the cross-org conflict) verbatim;
      // otherwise surface a clean, user-facing message (never raw provider JSON).
      if (e instanceof HttpError) throw e;
      const raw = e instanceof Error ? e.message : "";
      if (/already in use by another org/i.test(raw)) {
        throw new HttpError(
          409,
          `${row.number} is already registered to another account and can't be connected here. Assign a different number to this agent, or release ${row.number} from the account that currently holds it.`,
        );
      }
      throw new HttpError(
        502,
        `Couldn't connect ${row.number} to this agent. Please try again in a moment, or assign a different number.`,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    // Return the agent's previous number(s) to the system pool.
    if (previous.length) {
      await tx.phoneNumber.updateMany({
        where: { id: { in: previous.map((p) => p.id) } },
        data: { userId: null, assistantId: null, poolStatus: "AVAILABLE", status: "active" },
      });
    }
    // Free this number from any prior owner before binding it to the new one.
    await tx.profile.updateMany({
      where: { receptionistNumber: row.number },
      data: { receptionistNumber: "", numberActivated: false },
    });
    await tx.phoneNumber.update({
      where: { id },
      data: { userId: conv.userId, assistantId: routedAssistantId, poolStatus: "ASSIGNED", status: "active" },
    });
    await tx.profile.updateMany({
      where: { userId: conv.userId },
      data: { receptionistNumber: row.number, numberActivated: true },
    });
  });

  // Net pool change can be negative (agent had no prior number) — top it up.
  void replenishPool().catch(() => {});
}

/** Set the global SMS sender (the `from` on every post-call summary text). */
export async function assignSmsSender(number: string): Promise<string> {
  const clean = normalize(number);
  if (!/^\+?\d{6,15}$/.test(clean)) throw badRequest("That doesn't look like a valid phone number");
  await setSettingValue("twilio.fromNumber", clean);
  return clean;
}

/** Send a test SMS from the configured sender to a recipient, to verify the
 *  sender number works end-to-end. Surfaces Twilio's error verbatim on failure. */
export async function sendTestSms(to: string): Promise<{ from: string; to: string }> {
  if (!isTwilioConfigured()) throw notImplemented("Twilio is not configured");
  const from = normalize(getEffective("twilio.fromNumber"));
  if (!from) throw badRequest("Set an SMS sender number before sending a test");
  const clean = normalize(to);
  if (!/^\+?\d{6,15}$/.test(clean)) throw badRequest("Enter a valid recipient phone number");
  try {
    await sendSms(clean, "✅ hello22.ai test SMS — your sender number is configured correctly.");
  } catch (e) {
    throw new HttpError(502, describeSmsError(e));
  }
  return { from: getEffective("twilio.fromNumber"), to: clean };
}

/** Clear the SMS sender. Writes an empty override (not a delete) so it also
 *  masks any `TWILIO_FROM_NUMBER` coming from .env / the Twilio connection —
 *  the number fully disappears from the card AND Settings until reassigned. */
export async function unassignSmsSender(): Promise<void> {
  await setSettingValue("twilio.fromNumber", "");
}

/** Drop pool rows whose Twilio number the account no longer owns. */
/**
 * Reflect a self-serve number claim (from the customer setup wizard) in the
 * admin pool: release any other number the user held, then flip/create this
 * number's row to ASSIGNED under the user + their assistant. Best-effort caller.
 */
export async function markNumberAssignedToUser(opts: {
  userId: string;
  number: string;
  assistantId: string | null;
}): Promise<void> {
  // One number per agent — free any other number this user currently holds.
  await prisma.phoneNumber.updateMany({
    where: { userId: opts.userId, number: { not: opts.number } },
    data: { userId: null, assistantId: null, poolStatus: "AVAILABLE", status: "active" },
  });
  // Flip (or create) this number's row to ASSIGNED under the user.
  const existing = await prisma.phoneNumber.findUnique({ where: { number: opts.number } });
  const data = {
    userId: opts.userId,
    assistantId: opts.assistantId,
    poolStatus: "ASSIGNED",
    status: "active",
  };
  if (existing) {
    await prisma.phoneNumber.update({ where: { number: opts.number }, data });
  } else {
    await prisma.phoneNumber.create({ data: { number: opts.number, ...data } });
  }
}

/**
 * Release the number a user currently holds back to the system pool — without
 * touching their Vapi assistant (so a later re-subscribe reuses it). Used when a
 * post-trial grace period lapses. Mirrors the number side of
 * `deprovisionAgentForUser` but keeps the assistant. Returns the freed number
 * (for the notification), or null if the user held none. Best-effort on Vapi.
 */
export async function releaseUserNumberToPool(userId: string): Promise<string | null> {
  const rows = await prisma.phoneNumber.findMany({ where: { userId }, select: { number: true } });
  for (const r of rows) {
    if (r.number) await releaseVapiNumber(r.number);
  }
  await prisma.phoneNumber.updateMany({
    where: { userId },
    data: { userId: null, assistantId: null, poolStatus: "AVAILABLE", status: "active" },
  });
  await prisma.profile.update({ where: { userId }, data: { receptionistNumber: "" } });
  return rows[0]?.number ?? null;
}

export async function cleanupOrphaned(): Promise<{ removed: number; numbers: string[] }> {
  if (!isTwilioConfigured()) return { removed: 0, numbers: [] };
  const owned = await listTwilioNumbersDetailed();
  const ownedSids = new Set(owned.map((o) => o.sid));
  const ownedNums = new Set(owned.map((o) => normalize(o.number)));
  const rows = await prisma.phoneNumber.findMany();
  const orphans = rows.filter((r) =>
    r.twilioSid ? !ownedSids.has(r.twilioSid) : !ownedNums.has(normalize(r.number)),
  );
  if (orphans.length) {
    await prisma.phoneNumber.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  }
  return { removed: orphans.length, numbers: orphans.map((o) => o.number) };
}

/** Reset any number stuck in a non-active health status back to active. */
export async function clearSync(): Promise<{ changed: number; numbers: string[] }> {
  const stuck = await prisma.phoneNumber.findMany({ where: { status: { not: "active" } } });
  if (stuck.length) {
    await prisma.phoneNumber.updateMany({
      where: { id: { in: stuck.map((s) => s.id) } },
      data: { status: "active" },
    });
  }
  return { changed: stuck.length, numbers: stuck.map((s) => s.number) };
}

/** Ensure each customer's already-assigned `receptionistNumber` is tracked as an
 *  ASSIGNED pool row. Returns how many rows were created or repaired. */
async function backfillAssignments(): Promise<number> {
  const vapiOn = integrationsStatus().vapi;
  const profiles = await prisma.profile.findMany({
    where: { NOT: { receptionistNumber: "" } },
    select: {
      userId: true,
      receptionistNumber: true,
      user: { select: { conversion: { select: { vapiAssistantId: true } } } },
    },
  });
  let changed = 0;
  for (const p of profiles) {
    const assistantId = p.user.conversion?.vapiAssistantId ?? null;
    const existing = await prisma.phoneNumber.findUnique({ where: { number: p.receptionistNumber } });
    if (existing) {
      if (existing.userId !== p.userId || existing.poolStatus !== "ASSIGNED") {
        await prisma.phoneNumber.update({
          where: { id: existing.id },
          data: { userId: p.userId, assistantId, poolStatus: "ASSIGNED", status: "active" },
        });
        changed++;
      }
    } else {
      await prisma.phoneNumber.create({
        data: {
          number: p.receptionistNumber,
          provider: "twilio",
          userId: p.userId,
          assistantId,
          poolStatus: "ASSIGNED",
          status: "active",
          monthlyPriceCents:
            (await monthlyPriceCentsFor(p.receptionistNumber)) ?? DEFAULT_MONTHLY_CENTS,
        },
      });
      changed++;
    }

    // Push the assignment to Vapi too. The DB row alone doesn't make the live
    // agent answer calls — the number must be imported into Vapi and routed to the
    // assistant. Provisioning skips this once a DB row exists, so DB-only rows
    // (e.g. an earlier backfill) never reach Vapi. Re-importing here is idempotent
    // (importTwilioNumber re-routes an already-imported number). Best-effort: a
    // Vapi/cross-org failure must not break the whole resync.
    if (vapiOn && assistantId && p.receptionistNumber) {
      try {
        await importTwilioNumber({ number: p.receptionistNumber, assistantId });
      } catch (e) {
        console.error(
          `[resync] Vapi import/route failed for ${p.receptionistNumber}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
  return changed;
}

export interface ResyncResult {
  configured: boolean;
  purged: number;
  owned: number;
  inPool: number;
  missing: number;
  assignmentsSynced: number;
}

/** Reconcile the pool against the connected Twilio account. With creds removed
 *  it purges all Twilio rows (account switch); otherwise it repairs SIDs, maps
 *  existing assignments, and reports inventory. Throws if creds are rejected. */
export async function resyncTwilio(): Promise<ResyncResult> {
  if (!isTwilioConfigured()) {
    const purged = await prisma.phoneNumber.deleteMany({ where: { provider: "twilio" } });
    return { configured: false, purged: purged.count, owned: 0, inPool: 0, missing: 0, assignmentsSynced: 0 };
  }

  const owned = await listTwilioNumbersDetailed(); // throws on 401 → route maps to 502
  const rows = await prisma.phoneNumber.findMany();
  const byNum = new Map(rows.map((r) => [normalize(r.number), r]));

  let inPool = 0;
  for (const o of owned) {
    const r = byNum.get(normalize(o.number));
    if (r) {
      inPool++;
      // Reconcile both the Twilio SID and the real monthly price (backfills the
      // old flat $50 placeholder with the actual per-country Twilio rate).
      // SMS capability rides along here too — this is what backfills every row
      // that predates the column, so caller-facing texts can start using the
      // business's own number instead of the shared platform sender.
      const data: { twilioSid?: string; monthlyPriceCents?: number; smsCapable?: boolean } = {};
      if (!r.twilioSid) data.twilioSid = o.sid;
      if (r.smsCapable !== o.smsCapable) data.smsCapable = o.smsCapable;
      const realPrice = await monthlyPriceCentsFor(o.number);
      if (realPrice != null && realPrice !== r.monthlyPriceCents) data.monthlyPriceCents = realPrice;
      if (Object.keys(data).length) await prisma.phoneNumber.update({ where: { id: r.id }, data });
    }
  }
  const assignmentsSynced = await backfillAssignments();
  // Re-sync is the admin's "reconcile everything" action — give any cross-org
  // blocked numbers a fresh chance (e.g. after pointing at the right Vapi org).
  // If still locked, the next claim attempt simply re-blocks them.
  await clearBlockedNumbers().catch(() => {});
  return {
    configured: true,
    purged: 0,
    owned: owned.length,
    inPool,
    missing: owned.length - inPool,
    assignmentsSynced,
  };
}

/* ------------------------------------------------------------------ *
 *  Auto-replenish — keep at least `target` AVAILABLE numbers in the
 *  pool. Imports already-owned Twilio numbers first (free); only buys
 *  new ones when auto-purchase is enabled. Persisted as platform settings.
 * ------------------------------------------------------------------ */

const POOL_TARGET_KEY = "phones.poolTarget";
const AUTO_PURCHASE_KEY = "phones.autoPurchase";
const PURCHASE_COUNTRY_KEY = "phones.purchaseCountry";
const USER_PURCHASE_KEY = "phones.userPurchase";
const BLOCKED_NUMBERS_KEY = "phones.blockedNumbers";
const ALLOWED_COUNTRIES_KEY = "phones.allowedCountries";
const ALLOWED_PREFIXES_KEY = "phones.allowedPrefixes";
const DEFAULT_POOL_TARGET = 5;
const DEFAULT_PURCHASE_COUNTRY = "US";
// Countries customers may pick a number from during setup. AU + US are checked by
// default since that's where our existing customers are.
const DEFAULT_ALLOWED_COUNTRIES = ["US", "AU"];

const digitsOf = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/** Normalize an arbitrary value to a clean, de-duped list of 2-letter ISO codes. */
function normalizeCountryCodes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const codes = input
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.toUpperCase().slice(0, 2))
    .filter((c) => /^[A-Z]{2}$/.test(c));
  return [...new Set(codes)];
}

/** Parse the stored allowed-countries JSON, falling back to the default set. */
function parseAllowedCountries(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_COUNTRIES];
  const codes = (() => {
    try {
      return normalizeCountryCodes(JSON.parse(raw));
    } catch {
      return [];
    }
  })();
  return codes.length ? codes : [...DEFAULT_ALLOWED_COUNTRIES];
}

/** ISO codes of the countries customers may pick a number from during setup. */
export async function getAllowedCountries(): Promise<string[]> {
  const row = await prisma.platformSetting.findUnique({ where: { key: ALLOWED_COUNTRIES_KEY } });
  return parseAllowedCountries(row?.value);
}

/** Parse the stored allowed-prefixes JSON — `{ iso(lowercase): nationalPrefix[] }`.
 *  An absent country key means "all prefixes allowed"; an empty array means "none". */
function parseAllowedPrefixes(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(obj)) {
      const iso = k.toLowerCase().slice(0, 2);
      if (!/^[a-z]{2}$/.test(iso) || !Array.isArray(v)) continue;
      out[iso] = [...new Set(v.filter((p): p is string => typeof p === "string").map((p) => p.replace(/\D/g, "")).filter(Boolean))];
    }
    return out;
  } catch {
    return {};
  }
}

/** Per-country national prefixes customers may pick during setup. */
export async function getAllowedPrefixes(): Promise<Record<string, string[]>> {
  const row = await prisma.platformSetting.findUnique({ where: { key: ALLOWED_PREFIXES_KEY } });
  return parseAllowedPrefixes(row?.value);
}

/**
 * Numbers that live in the shared Twilio account but are locked to a DIFFERENT
 * Vapi organisation (e.g. a teammate imported them on their own local Vapi key),
 * so importing them into *this* project 409s with "already in use by another org".
 * We remember them (digit-only) so they stop being offered as claimable and don't
 * keep throwing the same error. Stored as a JSON array in platform_settings.
 */
export async function getBlockedNumberDigits(): Promise<Set<string>> {
  const row = await prisma.platformSetting.findUnique({ where: { key: BLOCKED_NUMBERS_KEY } });
  if (!row?.value) return new Set();
  try {
    const arr = JSON.parse(row.value) as unknown;
    return new Set(Array.isArray(arr) ? arr.map((n) => digitsOf(String(n))).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

/** Flag a number as locked to another Vapi org so it's no longer offered/claimable. */
export async function blockNumber(number: string): Promise<void> {
  const d = digitsOf(number);
  if (!d) return;
  const set = await getBlockedNumberDigits();
  if (set.has(d)) return;
  set.add(d);
  await setSettingValue(BLOCKED_NUMBERS_KEY, JSON.stringify([...set]));
}

/** Clear the cross-org block list — e.g. after pointing the app at the Vapi org
 *  that actually owns those numbers. */
export async function clearBlockedNumbers(): Promise<void> {
  await setSettingValue(BLOCKED_NUMBERS_KEY, "[]");
}

export interface ReplenishConfig {
  target: number;
  autoPurchase: boolean;
  country: string;
  /** Let customers buy a brand-new number (from Twilio inventory) during setup. */
  userPurchase: boolean;
  /** ISO codes of countries customers may pick a number from during setup. */
  allowedCountries: string[];
  /** Per-country national prefixes customers may pick (iso → prefix[]). */
  allowedPrefixes: Record<string, string[]>;
}

export async function getReplenishConfig(): Promise<ReplenishConfig> {
  const rows = await prisma.platformSetting.findMany({
    where: {
      key: {
        in: [
          POOL_TARGET_KEY,
          AUTO_PURCHASE_KEY,
          PURCHASE_COUNTRY_KEY,
          USER_PURCHASE_KEY,
          ALLOWED_COUNTRIES_KEY,
          ALLOWED_PREFIXES_KEY,
        ],
      },
    },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const target = Number(map.get(POOL_TARGET_KEY));
  return {
    target: Number.isInteger(target) && target >= 0 ? target : DEFAULT_POOL_TARGET,
    autoPurchase: map.get(AUTO_PURCHASE_KEY) === "true",
    country: (map.get(PURCHASE_COUNTRY_KEY) || DEFAULT_PURCHASE_COUNTRY).toUpperCase(),
    userPurchase: map.get(USER_PURCHASE_KEY) === "true",
    allowedCountries: parseAllowedCountries(map.get(ALLOWED_COUNTRIES_KEY)),
    allowedPrefixes: parseAllowedPrefixes(map.get(ALLOWED_PREFIXES_KEY)),
  };
}

/** Whether customers may buy their own brand-new number during setup. */
export async function isUserPurchaseEnabled(): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key: USER_PURCHASE_KEY } });
  return row?.value === "true";
}

export async function setReplenishConfig(input: {
  target?: number;
  autoPurchase?: boolean;
  country?: string;
  userPurchase?: boolean;
  allowedCountries?: string[];
  allowedPrefixes?: Record<string, string[]>;
}): Promise<ReplenishConfig> {
  const upsert = (key: string, value: string) =>
    prisma.platformSetting.upsert({
      where: { key },
      update: { value, isSecret: false },
      create: { key, value, isSecret: false },
    });
  const writes: Promise<unknown>[] = [];
  if (input.target !== undefined) {
    if (!Number.isInteger(input.target) || input.target < 0 || input.target > 100) {
      throw badRequest("Minimum pool size must be a whole number between 0 and 100");
    }
    writes.push(upsert(POOL_TARGET_KEY, String(input.target)));
  }
  if (input.autoPurchase !== undefined) {
    writes.push(upsert(AUTO_PURCHASE_KEY, input.autoPurchase ? "true" : "false"));
  }
  if (input.country !== undefined) {
    writes.push(upsert(PURCHASE_COUNTRY_KEY, input.country.toUpperCase().slice(0, 2)));
  }
  if (input.userPurchase !== undefined) {
    writes.push(upsert(USER_PURCHASE_KEY, input.userPurchase ? "true" : "false"));
  }
  if (input.allowedCountries !== undefined) {
    const codes = normalizeCountryCodes(input.allowedCountries);
    writes.push(upsert(ALLOWED_COUNTRIES_KEY, JSON.stringify(codes)));
  }
  if (input.allowedPrefixes !== undefined) {
    const clean: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(input.allowedPrefixes)) {
      const iso = k.toLowerCase().slice(0, 2);
      if (!/^[a-z]{2}$/.test(iso) || !Array.isArray(v)) continue;
      clean[iso] = [...new Set(v.map((p) => String(p).replace(/\D/g, "")).filter(Boolean))];
    }
    writes.push(upsert(ALLOWED_PREFIXES_KEY, JSON.stringify(clean)));
  }
  await Promise.all(writes);
  return getReplenishConfig();
}

export interface ReplenishResult {
  target: number;
  before: number;
  imported: number;
  purchased: number;
  available: number;
  autoPurchase: boolean;
  skipped?: string;
}

// In-process guard so concurrent triggers (two signups at once + a scheduler
// tick) don't all race to import/buy the same deficit.
let replenishing = false;

const availableCount = () =>
  prisma.phoneNumber.count({ where: { userId: null, poolStatus: "AVAILABLE", status: "active" } });

/** Top the pool back up to `target` AVAILABLE numbers: import owned Twilio
 *  numbers first, then buy the rest only if auto-purchase is enabled. Best-effort
 *  and idempotent — safe to call after every assignment and on a timer. */
export async function replenishPool(): Promise<ReplenishResult> {
  const cfg = await getReplenishConfig();
  if (!isTwilioConfigured()) {
    const available = await availableCount();
    return { target: cfg.target, before: available, imported: 0, purchased: 0, available, autoPurchase: cfg.autoPurchase, skipped: "twilio-not-configured" };
  }
  if (replenishing) {
    const available = await availableCount();
    return { target: cfg.target, before: available, imported: 0, purchased: 0, available, autoPurchase: cfg.autoPurchase, skipped: "already-running" };
  }

  replenishing = true;
  try {
    const before = await availableCount();
    let deficit = cfg.target - before;
    let imported = 0;
    let purchased = 0;
    if (deficit <= 0) {
      return { target: cfg.target, before, imported, purchased, available: before, autoPurchase: cfg.autoPurchase };
    }

    // 1) Import already-owned Twilio numbers not yet tracked (free).
    const [owned, tracked] = await Promise.all([
      listTwilioNumbersDetailed(),
      prisma.phoneNumber.findMany({ select: { number: true } }),
    ]);
    const have = new Set(tracked.map((r) => normalize(r.number)));
    for (const o of owned) {
      if (deficit <= 0) break;
      if (have.has(normalize(o.number))) continue;
      try {
        const monthlyPriceCents = (await monthlyPriceCentsFor(o.number)) ?? DEFAULT_MONTHLY_CENTS;
        await prisma.phoneNumber.create({
          data: { number: o.number, provider: "twilio", twilioSid: o.sid, smsCapable: o.smsCapable, status: "active", poolStatus: "AVAILABLE", monthlyPriceCents },
        });
        imported++;
        deficit--;
      } catch {
        /* unique-collision race — skip */
      }
    }

    // 2) Buy the remaining deficit — only when auto-purchase is enabled.
    if (deficit > 0 && cfg.autoPurchase) {
      const candidates = await searchAvailableNumbers({ country: cfg.country });
      for (const c of candidates) {
        if (deficit <= 0) break;
        if (await prisma.phoneNumber.findUnique({ where: { number: c.number } })) continue;
        try {
          const sid = await purchaseNumber(c.number);
          const monthlyPriceCents = (await monthlyPriceCentsFor(c.number)) ?? DEFAULT_MONTHLY_CENTS;
          await prisma.phoneNumber.create({
            data: { number: c.number, provider: "twilio", twilioSid: sid, smsCapable: await fetchSmsCapability(sid), status: "active", poolStatus: "AVAILABLE", monthlyPriceCents },
          });
          purchased++;
          deficit--;
        } catch (e) {
          console.error("[replenish] purchase failed:", e instanceof Error ? e.message : e);
        }
      }
    }

    const available = await availableCount();
    return { target: cfg.target, before, imported, purchased, available, autoPurchase: cfg.autoPurchase };
  } finally {
    replenishing = false;
  }
}
