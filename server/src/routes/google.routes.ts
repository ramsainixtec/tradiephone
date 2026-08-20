import express from "express";
import { z } from "zod";
import { asyncHandler, notImplemented } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { signState, verifyState } from "../lib/jwt.js";
import { prisma } from "../prisma.js";
import { corsOrigins } from "../env.js";
import {
  isGoogleConfigured,
  buildAuthUrl,
  exchangeCode,
  fetchGoogleEmail,
  saveTokens,
  getTokens,
  clearTokens,
  createCalendarEvent,
  deleteCalendarEvent,
} from "../services/google.js";

const router = express.Router();

router.get(
  "/auth-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isGoogleConfigured()) {
      throw notImplemented("Google is not configured (add Google OAuth keys in Admin → Settings)");
    }
    const url = buildAuthUrl(signState(req.user!.sub));
    res.json({ url });
  }),
);

// PUBLIC — Google redirects the browser here with ?code & ?state (no auth header).
router.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const frontendUrl = corsOrigins[0];
    try {
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      if (!code || !state) throw new Error("missing code/state");

      const userId = verifyState(state);
      const tokens = await exchangeCode(code);
      const email = await fetchGoogleEmail(tokens.access_token);

      await saveTokens(userId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        email,
      });
      await prisma.crmIntegration.upsert({
        where: { userId },
        update: { googleCalendarConnected: true },
        create: { userId, googleCalendarConnected: true },
      });

      // Booking (Google Calendar) is connected from the Booking module now, so
      // return the user there rather than Account Settings.
      res.redirect(`${frontendUrl}/dashboard/booking?google=connected`);
    } catch {
      res.redirect(`${frontendUrl}/dashboard/booking?google=error`);
    }
  }),
);

router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const crm = await prisma.crmIntegration.findUnique({ where: { userId } });
    const tokens = await getTokens(userId);
    res.json({ connected: !!crm?.googleCalendarConnected, email: tokens?.email || undefined });
  }),
);

router.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    await clearTokens(userId);
    await prisma.crmIntegration.upsert({
      where: { userId },
      update: { googleCalendarConnected: false },
      create: { userId, googleCalendarConnected: false },
    });
    res.json({ ok: true });
  }),
);

const eventSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  startISO: z.string().min(1),
  endISO: z.string().min(1),
});

router.post(
  "/events",
  requireAuth,
  asyncHandler(async (req, res) => {
    const evt = eventSchema.parse(req.body);
    const result = await createCalendarEvent(req.user!.sub, evt);
    res.json(result);
  }),
);

/** Connectivity self-test: create a short test event on the user's calendar and
 *  immediately delete it. Confirms the OAuth token can both WRITE and DELETE
 *  events (exactly what booking needs) without leaving anything behind. */
router.post(
  "/test",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const start = new Date(Date.now() + 5 * 60_000);
    const end = new Date(start.getTime() + 15 * 60_000);
    const created = await createCalendarEvent(userId, {
      summary: "Booking connection test (safe to ignore)",
      description: "Automatic test from your AI receptionist — this event is removed instantly.",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
    });
    if (!created.ok) {
      res.json({
        ok: false,
        message: created.error
          ? `Calendar test failed: ${created.error}`
          : "Couldn't create a test event on your calendar.",
      });
      return;
    }
    if (created.id) await deleteCalendarEvent(userId, created.id);
    res.json({ ok: true, message: "Google Calendar is working — test event created and removed." });
  }),
);

export default router;
