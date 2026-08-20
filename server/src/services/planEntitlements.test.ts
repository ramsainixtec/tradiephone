import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    profile: { findUnique: vi.fn() },
    conversion: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock("./billing.js", () => ({
  getTrialDays: vi.fn(async () => 14),
  getTrialMinutes: vi.fn(async () => 10),
}));

import { prisma } from "../prisma.js";
import { getPlanFeatures } from "./trial.js";

const findUnique = prisma.profile.findUnique as unknown as ReturnType<typeof vi.fn>;

/** A plan that grants nothing except SMS summaries — the "cheap tier" case. */
const CHEAP_PLAN = {
  smsEnabled: true,
  smsToCallerEnabled: false,
  whatsappEnabled: false,
  customCrmEnabled: false,
  multilingualEnabled: false,
};

const row = (over: Record<string, unknown> = {}) => ({
  subscriptionStatus: "active",
  // Signup-time policy snapshot; false = the card-less default every existing
  // account carries. Only meaningful while the status is still "none".
  cardRequiredAtSignup: false,
  cardConfirmedAt: null,
  user: { role: "USER" },
  subscriptionPlan: CHEAP_PLAN,
  ...over,
});

/* Entitlements hinge on PAYMENT, not on finishing the number wizard. The old
 * rule unlocked everything until a receptionist number existed, so someone who
 * had paid for a cheap plan kept every premium add-on until they got around to
 * claiming a number. These pin the new boundary. */

describe("getPlanFeatures", () => {
  beforeEach(() => findUnique.mockReset());

  it("restricts as soon as the payment lands, with no number claimed", async () => {
    findUnique.mockResolvedValue(row({ receptionistNumber: null }));
    const f = await getPlanFeatures("u1");
    expect(f.sms).toBe(true); // the one thing this plan includes
    expect(f.smsToCaller).toBe(false);
    expect(f.whatsapp).toBe(false);
    expect(f.customCrm).toBe(false);
    expect(f.multilingual).toBe(false);
  });

  it("gives the same answer once a number exists — the number is irrelevant now", async () => {
    findUnique.mockResolvedValue(row({ receptionistNumber: "+61468159801" }));
    expect(await getPlanFeatures("u1")).toEqual({
      sms: true,
      smsToCaller: false,
      whatsapp: false,
      customCrm: false,
      multilingual: false,
    });
  });

  it("leaves the free trial wide open so add-ons can be tried before buying", async () => {
    findUnique.mockResolvedValue(row({ subscriptionStatus: "trialing", subscriptionPlan: CHEAP_PLAN }));
    const f = await getPlanFeatures("u1");
    expect(f).toEqual({ sms: true, smsToCaller: true, whatsapp: true, customCrm: true, multilingual: true });
  });

  it("leaves a brand-new CARD-LESS signup open (nothing paid, nothing to enforce)", async () => {
    findUnique.mockResolvedValue(
      row({ subscriptionStatus: "none", cardRequiredAtSignup: false, subscriptionPlan: null }),
    );
    const f = await getPlanFeatures("u1");
    expect(f.smsToCaller).toBe(true);
  });

  /* Feature restriction is a PLAN concern, not an access one: nothing is
   * restricted until a plan activates, and then only to what that plan includes.
   * The card wall is deliberately NOT enforced here — an account with no card is
   * stopped by getEntitlement (and by the routes that spend money), not by
   * quietly stripping its add-ons. These pin that separation so a future change
   * doesn't smuggle access control back into this function. */
  it("keeps every add-on open through a card-required trial", async () => {
    findUnique.mockResolvedValue(
      row({
        subscriptionStatus: "trialing",
        cardRequiredAtSignup: true,
        cardConfirmedAt: new Date(),
        subscriptionPlan: CHEAP_PLAN, // a plan that grants almost nothing…
      }),
    );
    // …but the trial hasn't converted, so the plan's limits don't apply yet.
    const f = await getPlanFeatures("u1");
    expect(f).toEqual({
      sms: true,
      smsToCaller: true,
      whatsapp: true,
      customCrm: true,
      multilingual: true,
    });
  });

  it("does not restrict features for a card-required account still awaiting its card", async () => {
    findUnique.mockResolvedValue(
      row({
        subscriptionStatus: "none",
        cardRequiredAtSignup: true,
        cardConfirmedAt: null,
        subscriptionPlan: null,
      }),
    );
    const f = await getPlanFeatures("u1");
    expect(f.smsToCaller).toBe(true);
  });

  it("clamps to the plan the moment it activates, card-required or not", async () => {
    findUnique.mockResolvedValue(
      row({
        subscriptionStatus: "active",
        cardRequiredAtSignup: true,
        cardConfirmedAt: new Date(),
        subscriptionPlan: CHEAP_PLAN,
      }),
    );
    const f = await getPlanFeatures("u1");
    expect(f.sms).toBe(true); // the one thing this plan includes
    expect(f.smsToCaller).toBe(false);
    expect(f.whatsapp).toBe(false);
  });

  it("does NOT hand features back when a paid subscription lapses", async () => {
    for (const status of ["past_due", "suspended", "canceled"]) {
      findUnique.mockResolvedValue(row({ subscriptionStatus: status }));
      const f = await getPlanFeatures("u1");
      expect(f.smsToCaller, `status=${status}`).toBe(false);
      expect(f.sms, `status=${status}`).toBe(true); // still judged by the plan
    }
  });

  it("grants nothing when a paid status carries no plan", async () => {
    findUnique.mockResolvedValue(row({ subscriptionPlan: null }));
    const f = await getPlanFeatures("u1");
    expect(f).toEqual({
      sms: false,
      smsToCaller: false,
      whatsapp: false,
      customCrm: false,
      multilingual: false,
    });
  });

  it("gives admins everything regardless of plan or status", async () => {
    findUnique.mockResolvedValue(row({ user: { role: "ADMIN" }, subscriptionPlan: null }));
    const f = await getPlanFeatures("admin");
    expect(f).toEqual({ sms: true, smsToCaller: true, whatsapp: true, customCrm: true, multilingual: true });
  });

  it("grants nothing when the profile is missing entirely", async () => {
    findUnique.mockResolvedValue(null);
    // No profile → status defaults to "none" → still in setup, so open.
    const f = await getPlanFeatures("ghost");
    expect(f.smsToCaller).toBe(true);
  });
});
