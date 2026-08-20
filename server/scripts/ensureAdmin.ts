import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { seed } from "../prisma/seed.js";

/* ------------------------------------------------------------------ *
 *  Ensure at least one ADMIN exists. Runs on `npm run dev`.
 *  - No admin in the DB  -> applies the seed (admin + demo user)
 *  - Admin already there -> skips (won't reset passwords)
 * ------------------------------------------------------------------ */
const prisma = new PrismaClient();

try {
  const admins = await prisma.user.count({ where: { role: "ADMIN" } });
  if (admins === 0) {
    console.log("No admin found — seeding admin + demo user…");
    await seed();
  } else {
    console.log(`✅ Admin already exists (${admins}) — skipping seed.`);
  }
} finally {
  await prisma.$disconnect();
}
