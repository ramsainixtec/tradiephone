import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEFAULT_AGENT_CONFIG } from "../src/lib/agentConfig.js";

/* ------------------------------------------------------------------ *
 *  Create (or promote) an ADMIN user.
 *
 *  Usage:
 *    npm run create-admin                         # uses SEED_ADMIN_* from .env
 *    npm run create-admin -- --email a@b.com --password "Secret123" --name "Owner"
 *
 *  - If the email already exists, it's promoted to ADMIN and the password reset.
 *  - If new, a User + Profile + Conversion + CrmIntegration are created.
 * ------------------------------------------------------------------ */
const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`) || a === `--${name}`);
  if (!hit) return undefined;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const i = process.argv.indexOf(hit);
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : undefined;
}

async function main() {
  const email = (arg("email") ?? process.env.SEED_ADMIN_EMAIL ?? "admin@tradiephone.ai").trim();
  const password = arg("password") ?? process.env.SEED_ADMIN_PASSWORD ?? "Admin@12345";
  const fullName = arg("name") ?? process.env.SEED_ADMIN_NAME ?? "Admin";

  if (password.length < 8) {
    console.error("✖ Password must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await prisma.user.findUnique({
    where: { email },
    include: { profile: true, crm: true, conversion: true },
  });
  if (existing) {
    await prisma.user.update({
      where: { email },
      data: {
        role: "ADMIN",
        passwordHash,
        fullName,
        // A pre-existing user (e.g. a STAFF/RESELLER account) may have no customer
        // rows. ADMIN is customer-facing, so backfill any missing ones — without
        // them GET /api/profile 404s and the AI Brain page hangs on a skeleton.
        ...(existing.profile ? {} : { profile: { create: { businessName: "tradiephone.ai" } } }),
        ...(existing.crm ? {} : { crm: { create: {} } }),
        ...(existing.conversion
          ? {}
          : {
              conversion: {
                create: {
                  agentConfig: DEFAULT_AGENT_CONFIG as object,
                  dataCaptureFields: DEFAULT_AGENT_CONFIG.knowledge.captureFields as object,
                },
              },
            }),
      },
    });
    console.log(`✅ Promoted existing user to ADMIN: ${email}`);
  } else {
    await prisma.user.create({
      data: {
        email,
        fullName,
        role: "ADMIN",
        passwordHash,
        // No receptionistNumber — the admin draws a real pool number when they
        // first save their AI Brain (provisioning treats "" as "needs a number").
        profile: { create: { businessName: "tradiephone.ai" } },
        crm: { create: {} },
        conversion: {
          create: {
            agentConfig: DEFAULT_AGENT_CONFIG as object,
            dataCaptureFields: DEFAULT_AGENT_CONFIG.knowledge.captureFields as object,
          },
        },
      },
    });
    console.log(`✅ Created ADMIN: ${email}`);
  }
  console.log(`   Password: ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
