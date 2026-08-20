/**
 * Human Call Transfer API (tenant-side).
 *
 *   GET    /api/transfer                → the owner's transfer settings
 *   PATCH  /api/transfer                → update enable / number / timeout / message
 *   GET    /api/transfer/departments    → list departments
 *   POST   /api/transfer/departments    → add a department
 *   PATCH  /api/transfer/departments/:id → update a department
 *   DELETE /api/transfer/departments/:id → remove a department
 */
import express from "express";
import { asyncHandler, HttpError } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  settingsPatchSchema,
  departmentInputSchema,
  departmentPatchSchema,
  departmentsReplaceSchema,
  MAX_DEPARTMENTS,
} from "../lib/transfer.js";
import {
  getOrCreateSettings,
  updateSettings,
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  replaceDepartments,
} from "../services/transfer.js";
import { prisma } from "../prisma.js";

const router = express.Router();

router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getOrCreateSettings(req.user!.sub));
  }),
);

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const data = settingsPatchSchema.parse(req.body);
    res.json(await updateSettings(req.user!.sub, data));
  }),
);

router.get(
  "/departments",
  asyncHandler(async (req, res) => {
    res.json(await listDepartments(req.user!.sub));
  }),
);

// Replace the whole list in one atomic save (the single "Save Changes" button).
router.put(
  "/departments",
  asyncHandler(async (req, res) => {
    const { departments } = departmentsReplaceSchema.parse(req.body);
    res.json(await replaceDepartments(req.user!.sub, departments));
  }),
);

router.post(
  "/departments",
  asyncHandler(async (req, res) => {
    const data = departmentInputSchema.parse(req.body);
    const count = await prisma.transferDepartment.count({ where: { userId: req.user!.sub } });
    if (count >= MAX_DEPARTMENTS) {
      throw new HttpError(400, `You can add up to ${MAX_DEPARTMENTS} departments.`);
    }
    res.status(201).json(await createDepartment(req.user!.sub, data));
  }),
);

router.patch(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    const data = departmentPatchSchema.parse(req.body);
    const updated = await updateDepartment(req.user!.sub, req.params.id, data);
    if (!updated) throw new HttpError(404, "Department not found");
    res.json(updated);
  }),
);

router.delete(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    const ok = await deleteDepartment(req.user!.sub, req.params.id);
    if (!ok) throw new HttpError(404, "Department not found");
    res.json({ ok: true });
  }),
);

export default router;
