import express from "express";
import { z } from "zod";
import type { CrmIntegration } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { testWebhookDelivery } from "../services/webhook.js";
import { getEffective } from "../services/settings.js";
import { getPlanFeatures } from "../services/trial.js";

const router = express.Router();

router.use(requireAuth);

/** Find the user's CrmIntegration, creating an empty one if missing. */
async function getCrm(userId: string): Promise<CrmIntegration> {
  const existing = await prisma.crmIntegration.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.crmIntegration.create({ data: { userId } });
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const crm = await getCrm(req.user!.sub);
    // The admin-global Nexleon CRM (Admin → Settings) is the company default every
    // user's leads fall back to. Surface it so the dashboard can pre-fill it and
    // the user can either keep it or override with their own.
    res.json({
      ...crm,
      defaultNexleonUrl: getEffective("perfex.url").trim() || null,
      defaultNexleonFormKey: getEffective("perfex.formKey").trim() || null,
    });
  }),
);

const patchSchema = z.object({
  connectedProvider: z.string().optional(),
  customWebhookUrl: z.string().optional(),
  googleCalendarConnected: z.boolean().optional(),
  nexleonUrl: z.string().optional(),
  nexleonFormKey: z.string().optional(),
  // Google Calendar booking settings.
  bookingEnabled: z.boolean().optional(),
  bookingDurationMin: z.number().int().min(5).max(480).optional(),
  bookingCalendarId: z.string().optional(),
  bookingTimezone: z.string().optional(),
});

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const data = patchSchema.parse(req.body);
    const userId = req.user!.sub;

    // Custom CRM (webhook) delivery is a per-plan entitlement — reject attempts
    // to select the provider or set a webhook URL when the plan doesn't include it.
    if (data.connectedProvider === "custom" || data.customWebhookUrl?.trim()) {
      const features = await getPlanFeatures(userId);
      if (!features.customCrm) {
        res.status(403).json({
          error: "Your plan doesn't include Custom CRM integration. Upgrade to unlock it.",
        });
        return;
      }
    }

    await getCrm(userId);

    const crm = await prisma.crmIntegration.update({
      where: { userId },
      data: {
        ...(data.connectedProvider !== undefined ? { connectedProvider: data.connectedProvider } : {}),
        ...(data.customWebhookUrl !== undefined ? { customWebhookUrl: data.customWebhookUrl } : {}),
        ...(data.googleCalendarConnected !== undefined
          ? { googleCalendarConnected: data.googleCalendarConnected }
          : {}),
        ...(data.nexleonUrl !== undefined ? { nexleonUrl: data.nexleonUrl } : {}),
        ...(data.nexleonFormKey !== undefined ? { nexleonFormKey: data.nexleonFormKey } : {}),
        ...(data.bookingEnabled !== undefined ? { bookingEnabled: data.bookingEnabled } : {}),
        ...(data.bookingDurationMin !== undefined
          ? { bookingDurationMin: data.bookingDurationMin }
          : {}),
        ...(data.bookingCalendarId !== undefined
          ? { bookingCalendarId: data.bookingCalendarId }
          : {}),
        ...(data.bookingTimezone !== undefined ? { bookingTimezone: data.bookingTimezone } : {}),
      },
    });

    res.json(crm);
  }),
);

router.post(
  "/test-webhook",
  asyncHandler(async (req, res) => {
    const crm = await getCrm(req.user!.sub);
    // The test falls back to the custom webhook when Nexleon isn't fully
    // configured — block that path if the plan doesn't include Custom CRM.
    const usesNexleon =
      crm.connectedProvider === "perfex" && crm.nexleonUrl && crm.nexleonFormKey;
    if (!usesNexleon && crm.customWebhookUrl.trim()) {
      const features = await getPlanFeatures(req.user!.sub);
      if (!features.customCrm) {
        res.status(403).json({
          error: "Your plan doesn't include Custom CRM integration. Upgrade to unlock it.",
        });
        return;
      }
    }
    const result = await testWebhookDelivery(crm);
    res.json(result);
  }),
);

router.get(
  "/deliveries",
  asyncHandler(async (req, res) => {
    const crm = await getCrm(req.user!.sub);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || 20), 100);

    const [deliveries, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where: { crmIntegrationId: crm.id },
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      prisma.webhookDelivery.count({ where: { crmIntegrationId: crm.id } }),
    ]);

    res.json({ deliveries, total });
  }),
);

export default router;
