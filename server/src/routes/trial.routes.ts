import express from "express";
import { asyncHandler } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { getEntitlement, reconcileSubscription } from "../services/trial.js";

const router = express.Router();

router.use(requireAuth);

/** Live entitlement (trial or paid) for the signed-in user — drives the dashboard badges. */
router.get(
  "/status",
  asyncHandler(async (req, res) => {
    // Sync from Stripe first so an ended trial that auto-charged shows as active.
    await reconcileSubscription(req.user!.sub);
    const state = await getEntitlement(req.user!.sub);
    res.json({ success: true, ...state });
  }),
);

export default router;
