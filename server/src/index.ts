import express from "express";
import cors from "cors";
import morgan from "morgan";
import { env, corsOrigins } from "./env.js";
import { apiRouter } from "./routes/index.js";
import publicCallRouter from "./routes/publicCall.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { loadSettings, integrationsStatus } from "./services/settings.js";
import { seedEmailTemplates } from "./services/emailTemplates.js";
import { startScheduler } from "./services/scheduler.js";
import { getElevenLabsCatalog } from "./services/voices.js";
import { securityHeaders } from "./middleware/securityHeaders.js";

const app = express();

// Don't advertise the framework, and set the baseline security headers on every
// response (before routing, so 404s/errors carry them too).
app.disable("x-powered-by");
app.use(securityHeaders);

// Behind Render's load balancer the socket IP is the proxy, identical for every
// visitor — so without this, req.ip collapses all users into one value and the
// per-IP rate limiter locks EVERYONE out after one attacker's burst. Trust a
// fixed number of hops (not `true`, which would let a client spoof
// X-Forwarded-For) so req.ip is the real client address.
app.set("trust proxy", env.TRUST_PROXY_HOPS);

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(morgan("dev"));

// Stripe + WhatsApp webhooks need the raw body for signature verification; parse JSON everywhere else.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/billing/webhook") return next();
  if (req.path === "/api/whatsapp/webhook") return next();
  express.json({ limit: "2mb" })(req, res, next);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, integrations: integrationsStatus() });
});

app.use("/api", apiRouter);

// Public "More info" conversation page linked from the summary SMS. Top-level
// (not under /api) to keep the SMS link short and unguessable.
app.use("/c", publicCallRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// Open the port immediately so platform health checks pass fast (critical on
// cold starts / free-tier spin-ups) — don't block listening on the DB. Platform
// settings load in the background; integration values fall back to env until ready.
app.listen(env.PORT, () => {
  console.log(`🚀 API listening on http://localhost:${env.PORT}`);
  startScheduler();
  void loadSettings().then(() => {
    console.log(`   Integrations:`, integrationsStatus());
    // Seed any missing system-email templates (idempotent, best-effort).
    void seedEmailTemplates();
    // Warm the ElevenLabs voice catalog so the first AI-Brain visitor doesn't wait
    // on it. Must run AFTER loadSettings — the API key comes from settings.
    void getElevenLabsCatalog();
  });
});
