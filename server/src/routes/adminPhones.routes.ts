import express from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../lib/http.js";
import { requireAuth, requireAdminOrStaff, requirePermission } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import {
  getOverview,
  listAgents,
  twilioAvailable,
  twilioSearch,
  addSystem,
  reassign,
  assignSmsSender,
  unassignSmsSender,
  sendTestSms,
  cleanupOrphaned,
  clearSync,
  resyncTwilio,
  getReplenishConfig,
  setReplenishConfig,
  replenishPool,
} from "../services/phones.js";

const router = express.Router();
router.use(requireAuth, requireAdminOrStaff, requirePermission("phone_numbers"));

/* ------------------------------- Read ------------------------------- */
router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    res.json(await getOverview());
  }),
);

router.get(
  "/agents",
  asyncHandler(async (_req, res) => {
    res.json(await listAgents());
  }),
);

router.get(
  "/twilio-available",
  asyncHandler(async (_req, res) => {
    res.json(await twilioAvailable());
  }),
);

router.get(
  "/twilio-search",
  asyncHandler(async (req, res) => {
    const { country, areaCode, contains, type, prefix } = z
      .object({
        country: z.string().optional(),
        areaCode: z.string().optional(),
        contains: z.string().optional(),
        type: z.enum(["local", "mobile"]).optional(),
        prefix: z.string().optional(),
      })
      .parse(req.query);
    res.json(await twilioSearch({ country, areaCode, contains, type, prefix }));
  }),
);

/* ------------------------------ Mutations ------------------------------ */
router.post(
  "/add-system",
  requirePermission("phone_numbers", "create"),
  asyncHandler(async (req, res) => {
    const { number, sid, purchase } = z
      .object({ number: z.string(), sid: z.string().optional(), purchase: z.boolean().optional() })
      .parse(req.body);
    const created = await addSystem({ number, sid, purchase });
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: purchase ? "phones.purchase" : "phones.import",
      targetType: "phoneNumber",
      targetId: created.id,
      metadata: { number },
      ip: req.ip,
    });
    res.json(created);
  }),
);

router.post(
  "/:id/reassign",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const { agentId } = z.object({ agentId: z.string().optional() }).parse(req.body ?? {});
    await reassign(req.params.id, agentId ?? null);
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: agentId ? "phones.assign" : "phones.toPool",
      targetType: "phoneNumber",
      targetId: req.params.id,
      metadata: { agentId: agentId ?? null },
      ip: req.ip,
    });
    res.json(await getOverview());
  }),
);

router.post(
  "/assign-sms",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const { number } = z.object({ number: z.string() }).parse(req.body);
    const sender = await assignSmsSender(number);
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.smsSender.set",
      targetType: "setting",
      metadata: { number: sender },
      ip: req.ip,
    });
    res.json({ smsSender: sender });
  }),
);

router.post(
  "/unassign-sms",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    await unassignSmsSender();
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.smsSender.clear",
      targetType: "setting",
      ip: req.ip,
    });
    res.json({ smsSender: null });
  }),
);

router.post(
  "/test-sms",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const { to } = z.object({ to: z.string() }).parse(req.body);
    const result = await sendTestSms(to);
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.smsSender.test",
      targetType: "setting",
      metadata: result,
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  }),
);

/* --------------------------- Auto-replenish --------------------------- */
router.get(
  "/replenish-config",
  asyncHandler(async (_req, res) => {
    res.json(await getReplenishConfig());
  }),
);

router.put(
  "/replenish-config",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        target: z.number().int().min(0).max(100).optional(),
        autoPurchase: z.boolean().optional(),
        country: z.string().min(2).max(2).optional(),
        userPurchase: z.boolean().optional(),
        allowedCountries: z.array(z.string().length(2)).max(60).optional(),
        allowedPrefixes: z.record(z.array(z.string().max(4)).max(20)).optional(),
      })
      .parse(req.body);
    const config = await setReplenishConfig(body);
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.replenishConfig",
      targetType: "setting",
      metadata: config,
      ip: req.ip,
    });
    res.json(config);
  }),
);

router.post(
  "/replenish",
  requirePermission("phone_numbers", "create"),
  asyncHandler(async (req, res) => {
    const result = await replenishPool();
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.replenish",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

router.post(
  "/cleanup-orphaned",
  requirePermission("phone_numbers", "delete"),
  asyncHandler(async (req, res) => {
    const result = await cleanupOrphaned();
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.cleanupOrphaned",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

router.post(
  "/clear-sync",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    const result = await clearSync();
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.clearSync",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

router.post(
  "/resync-twilio",
  requirePermission("phone_numbers", "edit"),
  asyncHandler(async (req, res) => {
    let result;
    try {
      result = await resyncTwilio();
    } catch (e) {
      // Rejected/typo'd creds look identical — surface the error, change nothing.
      throw new HttpError(502, `Twilio reconciliation failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    void audit({
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: "phones.resyncTwilio",
      targetType: "phoneNumber",
      metadata: result,
      ip: req.ip,
    });
    res.json(result);
  }),
);

export default router;
