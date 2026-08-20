import express from "express";
import { z } from "zod";
import { isValidPhoneNumber, parsePhoneNumberFromString } from "libphonenumber-js/max";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, unauthorized, notFound, HttpError } from "../lib/http.js";
import { signToken } from "../lib/jwt.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { serializeUser } from "../lib/serialize.js";
import { requireAuth } from "../middleware/auth.js";
import { DEFAULT_AGENT_CONFIG, clampName, titleCaseName } from "../lib/agentConfig.js";
import { createOtp, consumeOtp, sendOtpEmail, sendOtpSms, signupCodeMatches, type SignupPayload } from "../services/otp.js";
import { integrationsStatus, getOnboardingCardRequired } from "../services/settings.js";
import { sendEmail } from "../services/email.js";
import { reconcileSubscription } from "../services/trial.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { formatSignupTime, isValidTimeZone, resolveBusinessTimeZone } from "../lib/phoneTimeZone.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { notify, notifyAdmins } from "../services/notifications.js";

const router = express.Router();

/** Best-effort: email every admin a new customer signed up, with their details. */
async function notifyAdminsOfSignup(details: {
  fullName: string;
  email: string;
  businessName: string;
  mobile?: string;
  businessNumber?: string;
  address?: string;
  referralCode?: string;
  /** IANA timezone the browser reported at signup, if any. */
  timezone?: string;
}) {
  if (!integrationsStatus().email) return;
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { email: true } });
  if (!admins.length) return;

  const row = (label: string, value?: string) =>
    value && value.trim() ? `<li><strong>${label}:</strong> ${escapeHtml(value.trim())}</li>` : "";
  // Show the signup time in the customer's own region — the timezone their
  // browser reported at signup, falling back to one derived from their phone
  // number — with the timezone label so admins never mistake it for server/UTC time.
  const when = formatSignupTime(new Date(), { timezone: details.timezone, mobile: details.mobile });

  await sendEmail({
    to: admins.map((a) => a.email).join(","),
    subject: `New signup: ${details.businessName || details.fullName}`,
    html:
      `<h2>New customer signup</h2>` +
      `<p>A new customer just signed up and started their free trial. No action needed — they go live automatically once they add a plan and claim a number.</p>` +
      `<ul>` +
      row("Name", details.fullName) +
      row("Email", details.email) +
      row("Mobile", details.mobile) +
      row("Business", details.businessName) +
      row("Business number", details.businessNumber) +
      row("Address", details.address) +
      row("Referral code", details.referralCode) +
      `<li><strong>Signed up:</strong> ${escapeHtml(when)}</li>` +
      `</ul>` +
      `<p>Review them in Admin → Customers.</p>`,
  });
}

/** Best-effort: email + in-app notify the reseller when someone signs up through
 *  their referral link, with the new customer's details. */
async function notifyReferrerOfSignup(
  referrerId: string,
  details: {
    fullName: string;
    email: string;
    businessName: string;
    mobile?: string;
    businessNumber?: string;
    address?: string;
  },
): Promise<void> {
  const reseller = await prisma.user.findUnique({
    where: { id: referrerId },
    select: { email: true, fullName: true },
  });
  if (!reseller) return;

  void notify(referrerId, {
    type: "new_lead",
    title: "New referral signup 🎉",
    message: `${details.fullName}${details.businessName ? ` (${details.businessName})` : ""} signed up using your referral link.`,
    link: "/reseller",
  });

  if (!integrationsStatus().email) return;
  const row = (label: string, value?: string) =>
    value && value.trim() ? `<li><strong>${label}:</strong> ${escapeHtml(value.trim())}</li>` : "";
  await sendEmail({
    to: reseller.email,
    subject: `New referral signup: ${details.businessName || details.fullName}`,
    html:
      `<p>Hi ${escapeHtml(reseller.fullName)},</p>` +
      `<p>Good news — a new customer just signed up using your referral link:</p>` +
      `<ul>` +
      row("Name", details.fullName) +
      row("Email", details.email) +
      row("Business", details.businessName) +
      row("Mobile", details.mobile) +
      row("Business number", details.businessNumber) +
      row("Address", details.address) +
      `</ul>` +
      `<p>You'll earn commission once they're on a paid plan. Track your referrals in your reseller portal.</p>`,
  });
}

/** Resolve a referral code to a reseller's user id (if valid). */
async function resolveReferrer(referralCode?: string): Promise<string | undefined> {
  if (!referralCode?.trim()) return undefined;
  const reseller = await prisma.user.findFirst({
    where: { referralCode: referralCode.trim(), role: "RESELLER" },
    select: { id: true },
  });
  return reseller?.id;
}

/** E.164-normalise a mobile for storage/comparison; falls back to the trimmed
 *  input when it can't be parsed (the register schema already rejects invalid). */
function normalizeMobile(mobile: string): string {
  return parsePhoneNumberFromString(mobile.trim())?.number ?? mobile.trim();
}

/**
 * Enforce one account per mobile number — mirrors the one-card-per-account rule.
 * Throws 409 with a clear message if another account already uses this number.
 * No-op when blank (mobile is optional).
 */
async function assertMobileAvailable(mobile?: string): Promise<void> {
  const raw = mobile?.trim();
  if (!raw) return;
  const existing = await prisma.profile.findFirst({
    where: { mobile: normalizeMobile(raw) },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(
      409,
      "This mobile number is already registered. Please use a different number or log in.",
    );
  }
}

/** Create a fresh user with the default profile/agent/crm records, then a session token. */
async function createUser(data: {
  email: string;
  passwordHash: string;
  fullName: string;
  businessName: string;
  mobile?: string;
  businessNumber?: string;
  address?: string;
  referralCode?: string;
  viaOnboarding?: boolean;
  timezone?: string;
  /** Snapshot of the platform card-required policy, frozen at /register/start so
   *  the OTP window can't change it. Omitted by the direct /register route, which
   *  falls back to reading the live setting here. */
  cardRequired?: boolean;
}) {
  // One account per mobile — re-checked here (not just at /register/start) so a
  // race between two pending sign-ups can't create two accounts on one number.
  await assertMobileAvailable(data.mobile);
  const referredById = await resolveReferrer(data.referralCode);
  // Freeze the platform's card-required policy onto this row. This is the ONLY
  // place the setting is read for a customer account — every gate downstream
  // (getEntitlement, getPlanFeatures, /confirm-card, the client cardWallActive)
  // reads the stamped column instead, so flipping the admin toggle can never
  // retroactively wall an account that is already live.
  const cardRequired = data.cardRequired ?? (await getOnboardingCardRequired());
  // A fresh profile stays subscriptionStatus="none". Under the card-less policy
  // that IS their free trial; under the card-required policy it means "no card
  // yet" and the app walls them on the plan picker until one lands.
  // Personalise the agent config with the business captured at signup so the AI
  // Brain, system prompt, and Vapi assistant all reflect it — the assistant is
  // named after the business (e.g. "Redtape Receptionist").
  const signupBusiness = data.businessName?.trim() || "";
  // Resolve the operating timezone from the strongest signals we have at signup
  // — the business's phone number and street address (where its callers are),
  // refined to a city by the browser's zone. The owner confirms/overrides it in
  // Rules; this only decides what that field says when they first open it,
  // instead of every account starting life in Sydney.
  const signupTimeZone = resolveBusinessTimeZone({
    businessNumber: data.businessNumber,
    mobile: data.mobile,
    address: data.address,
    browserTimeZone: data.timezone,
  });
  const agentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    identity: {
      ...DEFAULT_AGENT_CONFIG.identity,
      businessName: signupBusiness,
      assistantName: signupBusiness
        ? `${signupBusiness} Receptionist`
        : DEFAULT_AGENT_CONFIG.identity.assistantName,
    },
    rules: { ...DEFAULT_AGENT_CONFIG.rules, timezone: signupTimeZone },
  };
  // Guided-onboarding sign-ups resume at step 5 (Services) after verification;
  // direct sign-ups skip the funnel and are marked complete immediately.
  const onboarding = data.viaOnboarding
    ? { onboardingStep: 5 }
    : { onboardingStep: 0, onboardingCompletedAt: new Date() };
  const user = await prisma.user.create({
    data: {
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      role: "USER",
      referredById,
      profile: {
        create: {
          businessName: data.businessName,
          receptionistNumber: "",
          ...(data.mobile?.trim() ? { mobile: normalizeMobile(data.mobile) } : {}),
          ...(data.businessNumber?.trim() ? { businessNumber: data.businessNumber.trim() } : {}),
          ...(data.address?.trim() ? { address: data.address.trim() } : {}),
          ...(isValidTimeZone(data.timezone) ? { timezone: data.timezone!.trim() } : {}),
          ...onboarding,
          cardRequiredAtSignup: cardRequired,
        },
      },
      conversion: {
        create: {
          agentConfig: agentConfig as object,
          dataCaptureFields: DEFAULT_AGENT_CONFIG.knowledge.captureFields as object,
        },
      },
      crm: { create: {} },
    },
    include: { profile: true },
  });
  // Self-serve: a new signup provisions automatically once they add a plan +
  // claim a number — no admin approval needed. Notify admins for visibility only.
  void notifyAdminsOfSignup({
    fullName: user.fullName,
    email: user.email,
    businessName: data.businessName,
    mobile: data.mobile,
    businessNumber: data.businessNumber,
    address: data.address,
    referralCode: data.referralCode,
    timezone: data.timezone,
  }).catch(() => {});
  void notifyAdmins({
    type: "system",
    title: `New signup: ${data.businessName?.trim() || user.fullName}`,
    message: `${user.fullName} just signed up and started their free trial.`,
    link: "/dashboard/admin/customers",
  });
  void notify(user.id, {
    type: "agent",
    title: "Welcome to hello22.ai",
    message: "Your dashboard is ready. Explore the AI Brain to customize your assistant.",
    link: "/dashboard/assistant",
  });
  // If they came through a reseller's referral link, email + notify that reseller.
  if (referredById) {
    void notifyReferrerOfSignup(referredById, {
      fullName: user.fullName,
      email: user.email,
      businessName: data.businessName,
      mobile: data.mobile,
      businessNumber: data.businessNumber,
      address: data.address,
    }).catch(() => {});
  }
  const token = signToken({ sub: user.id, email: user.email, role: user.role, permissions: user.permissions ?? [] });
  return { token, user };
}

// Strong-password policy — mirrored on the client (src/pages/auth/authSchemas.ts)
// so a weak password can't slip through by calling the API directly.
const strongPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(40, "Password must be at most 40 characters")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[^A-Za-z0-9]/, "Password must include a special character");

const registerSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  // Always store a person's name title-cased ("redtape" -> "Redtape") so it
  // reads correctly everywhere it's displayed.
  fullName: z.string().min(1).transform(titleCaseName),
  // Clamp to 40 (Vapi's assistant-name limit) instead of rejecting, so signup
  // never fails on a long scraped business name.
  businessName: z.string().transform(clampName).optional(),
  // Must be a valid E.164 number per libphonenumber's per-country rules — mirrors
  // the client check so a malformed number can't slip through by calling the API
  // directly. Empty/omitted stays allowed (the field is optional).
  mobile: z
    .string()
    .optional()
    .refine((v) => !v?.trim() || isValidPhoneNumber(v.trim()), "Enter a valid phone number"),
  businessNumber: z.string().optional(),
  address: z.string().optional(),
  referralCode: z.string().optional(),
  viaOnboarding: z.boolean().optional(),
  // The visitor's IANA timezone (e.g. "Asia/Kolkata") captured by the browser at
  // signup, so notifications can show times in the customer's own region. Junk is
  // dropped (not rejected) — the email falls back to a phone-derived timezone.
  timezone: z
    .string()
    .optional()
    .transform((v) => (isValidTimeZone(v) ? v!.trim() : undefined)),
});

// Direct sign-up (no email verification) — used by the guided onboarding funnel,
// which already collects the details step by step. The login page uses the
// OTP-verified /register/start + /register/verify flow below.
// Per-IP (now that the app trusts the proxy and sees real client IPs). Shared
// across register/login/OTP, and several users can sit behind one office NAT, so
// keep enough headroom for honest multi-step + retry traffic while still cutting
// brute force off long before it's useful (thousands/min).
const authLimiter = rateLimit({ windowMs: 60_000, max: 30 });

router.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, fullName, businessName, mobile, businessNumber, address, referralCode, viaOnboarding, timezone } =
      registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, "Email already registered");
    await assertMobileAvailable(mobile);

    const passwordHash = await hashPassword(password);
    const { token, user } = await createUser({
      email,
      passwordHash,
      fullName,
      businessName: businessName ?? "",
      mobile,
      businessNumber,
      address,
      referralCode,
      viaOnboarding,
      timezone,
    });
    res.json({ token, user: serializeUser(user) });
  }),
);

// Step 1 of sign-up: validate, stash the (hashed) details on an OTP, email the code.
// The user is not created until the code is verified.
router.post(
  "/register/start",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, fullName, businessName, mobile, businessNumber, address, referralCode, viaOnboarding, timezone } =
      registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, "Email already registered");
    await assertMobileAvailable(mobile);

    const passwordHash = await hashPassword(password);
    const payload: SignupPayload = {
      passwordHash,
      fullName,
      businessName: businessName ?? "",
      mobile,
      businessNumber,
      address,
      referralCode,
      viaOnboarding,
      timezone,
      // Frozen now so an admin flipping the toggle during the OTP window can't
      // stamp this account with a policy the user was never shown.
      cardRequired: await getOnboardingCardRequired(),
    };
    const code = await createOtp({ email, purpose: "signup", payload });
    await sendOtpEmail(email, code, "signup");
    // Also text the same code to the owner's mobile (best-effort — never blocks signup).
    await sendOtpSms(mobile, code, "signup");

    res.json({ ok: true, email });
  }),
);

const otpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4),
});

// Step 2 of sign-up: verify the code and create the account from the pending payload.
router.post(
  "/register/verify",
  asyncHandler(async (req, res) => {
    const { email, code } = otpVerifySchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email }, include: { profile: true } });
    if (existing) {
      // Recovery: a prior verify likely created the account but its response was
      // lost (slow/cold DB), leaving the client stuck on the OTP step. If the same
      // code still matches, just re-issue the session instead of 409-ing.
      if (!(await signupCodeMatches(email, code))) {
        throw new HttpError(409, "Email already registered");
      }
      const token = signToken({ sub: existing.id, email: existing.email, role: existing.role, permissions: existing.permissions ?? [] });
      res.json({ token, user: serializeUser(existing) });
      return;
    }

    const row = await consumeOtp(email, "signup", code);
    const payload = row.payload as SignupPayload | null;
    if (!payload) throw badRequest("Sign-up details expired. Please sign up again.");

    const { token, user } = await createUser({ email, ...payload });
    res.json({ token, user: serializeUser(user) });
  }),
);

const emailOnlySchema = z.object({ email: z.string().email() });

// Re-issue a sign-up code, reusing the pending details from the prior code.
router.post(
  "/register/resend",
  asyncHandler(async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    const prior = await prisma.verificationCode.findFirst({
      where: { email, purpose: "signup", consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const payload = prior?.payload as SignupPayload | null;
    if (!payload) {
      // No pending code: if the account already exists, the sign-up finished —
      // point them to logging in rather than restarting.
      const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      throw badRequest(
        existing
          ? "This email is already registered. Please log in instead."
          : "No pending sign-up found. Please start again.",
      );
    }
    const code = await createOtp({ email, purpose: "signup", payload });
    await sendOtpEmail(email, code, "signup");
    // Re-send to the mobile captured on the pending sign-up too (best-effort).
    await sendOtpSms(payload.mobile, code, "signup");
    res.json({ ok: true });
  }),
);

// Step 1 of reset: email a reset code. Rejects an unknown email with a clear
// error so the user knows there's no account (we favour UX clarity here over
// hiding which emails are registered).
router.post(
  "/forgot-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw notFound("No account found with that email address.");
    const code = await createOtp({ email, purpose: "password_reset" });
    await sendOtpEmail(email, code, "password_reset");
    res.json({ ok: true });
  }),
);

const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4),
  newPassword: z.string().min(8).max(40, "Password must be at most 40 characters"),
});

// Step 2 of reset: verify the code, set the new password, and sign the user in.
router.post(
  "/reset-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, code, newPassword } = resetSchema.parse(req.body);

    await consumeOtp(email, "password_reset", code);

    const user = await prisma.user.findUnique({ where: { email }, include: { profile: true } });
    if (!user) throw notFound("User not found");

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    const token = signToken({ sub: user.id, email: user.email, role: user.role, permissions: user.permissions ?? [] });
    res.json({ token, user: serializeUser(user) });
  }),
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

router.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
      include: { profile: true, staffRole: { select: { name: true } } },
    });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized("Invalid email or password");
    }

    // An admin-suspended account is locked out entirely — block login and tell the
    // user clearly (not a generic credentials error) so they know to reach support.
    if (user.profile?.suspendedAt) {
      throw new HttpError(
        403,
        "Your account has been suspended. Please contact support if you think this is a mistake.",
        "account_suspended",
      );
    }

    const token = signToken({ sub: user.id, email: user.email, role: user.role, permissions: user.permissions ?? [] });
    res.json({ token, user: serializeUser(user) });
  }),
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Reconcile a possibly-stale trial from Stripe first, so an ended trial that
    // auto-charged the card shows as active (not "needs to subscribe again").
    await reconcileSubscription(req.user!.sub);

    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      include: { profile: true, staffRole: { select: { name: true } } },
    });
    // The account was deleted (e.g. directly in the DB) — invalidate the session
    // with a 401 so the frontend logs the dead token out instead of erroring.
    if (!user) throw unauthorized("Your session is no longer valid");
    // Admin suspended this account mid-session — kick the live session out so the
    // user can't keep using the dashboard. The frontend treats this code as a
    // hard logout and routes to /login with a "suspended" notice.
    if (user.profile?.suspendedAt) {
      throw new HttpError(403, "Your account has been suspended.", "account_suspended");
    }
    res.json({ user: serializeUser(user) });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(40, "Password must be at most 40 characters"),
});

router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw notFound("User not found");

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw badRequest("Current password is incorrect");
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    res.json({ ok: true });
  }),
);

export default router;
