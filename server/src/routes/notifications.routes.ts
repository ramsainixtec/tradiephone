import express from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
} from "../services/notifications.js";
import { integrationsStatus, getEffective } from "../services/settings.js";
import { getPlanFeatures, getEntitlement, entitlementError } from "../services/trial.js";
import { callSummaryEmail } from "../services/email.js";
import { isTwilioConfigured, callSummarySms, describeSmsError } from "../services/sms.js";
import { isWhatsAppConfigured, callSummaryWhatsApp } from "../services/whatsapp.js";

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEST_SUMMARY =
  "This is a test call summary from Tradie Phone. If you received this, your notifications are set up correctly.";
// Sample caller number so the test summary shows the same "from <number>" line a real call would.
const TEST_CALLER_NUMBER = "+1 555 0100";

const testSummarySchema = z.object({
  channel: z.enum(["email", "sms", "whatsapp"]),
  to: z.string().trim().min(1, "A destination is required."),
});

/**
 * Which summary channels the user's plan includes. Email is always available;
 * SMS / WhatsApp depend on the subscription plan (admins get all). The UI shows
 * only the included channels.
 */
router.get(
  "/channels",
  requireAuth,
  asyncHandler(async (req, res) => {
    const features = await getPlanFeatures(req.user!.sub);
    res.json({
      email: true,
      sms: features.sms,
      smsToCaller: features.smsToCaller,
      whatsapp: features.whatsapp,
      customCrm: features.customCrm,
      multilingual: features.multilingual,
    });
  }),
);

/**
 * Send a dummy call-summary to verify a channel. Customer-facing (any logged-in
 * user can test their own destination). Uses the same admin-configured sender as
 * real summaries. For SUMMARIES only — never used for login/OTP.
 */
router.post(
  "/test-summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = testSummarySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const { channel, to } = parsed.data;

    if (channel === "email" && !EMAIL_RE.test(to)) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }

    // This route sends a REAL message to a caller-supplied destination, so it
    // spends Twilio/Meta money on demand. Entitlement — not plan features — is
    // what decides whether an account may use the service at all, and a
    // card-required signup that hasn't added a card is entitled to nothing.
    // (Plan features stay wide open through the whole trial by design; the check
    // below only enforces which channels a PAID plan includes.)
    if (req.user!.role !== "ADMIN") {
      const ent = await getEntitlement(req.user!.sub);
      if (ent.blocked) {
        const { code, message } = entitlementError(ent);
        res.status(403).json({ error: message, code });
        return;
      }
    }

    // Channel must be included in the user's plan (email always allowed).
    if (channel !== "email") {
      const features = await getPlanFeatures(req.user!.sub);
      if ((channel === "sms" && !features.sms) || (channel === "whatsapp" && !features.whatsapp)) {
        res.status(403).json({ error: `Your plan doesn't include ${channel.toUpperCase()} summaries.` });
        return;
      }
    }

    const businessName =
      (
        await prisma.user.findUnique({
          where: { id: req.user!.sub },
          select: { profile: { select: { businessName: true } } },
        })
      )?.profile?.businessName || undefined;

    try {
      if (channel === "email") {
        if (!integrationsStatus().email) {
          res.status(400).json({ error: "Email sending isn't configured yet. Ask an admin to set it up." });
          return;
        }
        await callSummaryEmail({ ownerEmail: to, callerName: "Test Caller", callerNumber: TEST_CALLER_NUMBER, summary: TEST_SUMMARY });
      } else if (channel === "sms") {
        if (!isTwilioConfigured() || !getEffective("twilio.fromNumber").trim()) {
          res.status(400).json({ error: "SMS sending isn't configured yet. Ask an admin to set it up." });
          return;
        }
        await callSummarySms({ to, callerName: "Test Caller", callerNumber: TEST_CALLER_NUMBER, summary: TEST_SUMMARY, businessName });
      } else {
        if (!isWhatsAppConfigured()) {
          res.status(400).json({ error: "WhatsApp sending isn't configured yet. Ask an admin to set it up." });
          return;
        }
        await callSummaryWhatsApp({ to, callerName: "Test Caller", callerNumber: TEST_CALLER_NUMBER, summary: TEST_SUMMARY, businessName });
      }
      res.json({ ok: true, to });
    } catch (err) {
      console.error("[test-summary] failed:", err);
      const error =
        channel === "sms"
          ? describeSmsError(err)
          : "Couldn't send the test message. Check the sender configuration.";
      res.status(502).json({ error });
    }
  }),
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(userId),
      prisma.notification.count({ where: { userId, read: false } }),
    ]);
    res.json({ notifications, unreadCount });
  }),
);

router.post(
  "/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    await markNotificationRead(req.user!.sub, req.params.id);
    res.json({ ok: true });
  }),
);

router.post(
  "/read-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    await markAllNotificationsRead(req.user!.sub);
    res.json({ ok: true });
  }),
);

router.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    await clearNotifications(req.user!.sub);
    res.json({ ok: true });
  }),
);

export default router;
