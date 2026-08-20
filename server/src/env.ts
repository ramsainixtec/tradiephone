import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5174"),
  // Number of reverse-proxy hops in front of the app (Render's load balancer = 1).
  // Express uses this to take the real client IP from the RIGHT of X-Forwarded-For
  // — a specific count (not `true`) so a client can't spoof the header to forge an
  // IP. Wrong-too-low → everyone shares the proxy's IP (per-IP rate limits become
  // global); wrong-too-high → clients can spoof. Override only if infra adds hops.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  // Public base URL of the customer-facing app (e.g. https://agent.tradiephone.ai).
  // Used to build login links in account emails (staff/reseller credentials).
  // Falls back to the first CORS origin, then the production URL, so the link is
  // never broken even if this is unset.
  APP_URL: z.string().optional().default(""),
  // At least 32 chars: JWT_SECRET is the single key behind every login,
  // impersonation, unsubscribe and recording token — a short/guessable value is
  // brute-forceable and would let an attacker forge any of them. Boot fails loudly
  // rather than run on a weak secret. Generate one with: openssl rand -base64 48
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // Integrations (optional — features return 501 until configured)
  VAPI_API_KEY: z.string().optional().default(""),
  VAPI_PUBLIC_KEY: z.string().optional().default(""),
  // Public base URL Vapi posts call events to (e.g. an ngrok tunnel in dev).
  // When set, the assistant is created with server.url → post-call webhooks fire.
  VAPI_SERVER_URL: z.string().optional().default(""),
  // Public base URL of this API (e.g. https://api.example.com). Used to show the
  // WhatsApp webhook callback URL in admin. Falls back to VAPI_SERVER_URL.
  PUBLIC_API_URL: z.string().optional().default(""),
  // Host used to build the "More info" conversation link in the summary SMS.
  // Set this to a brand/short domain (e.g. https://agent.tradiephone.ai) that proxies
  // /c/* to this API, so the SMS shows the brand domain instead of the api host.
  // Blank → falls back to PUBLIC_API_URL (the raw API host).
  SHARE_LINK_BASE_URL: z.string().optional().default(""),

  DEEPGRAM_API_KEY: z.string().optional().default(""),
  ELEVENLABS_API_KEY: z.string().optional().default(""),

  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),

  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().default("tradiephone.ai <support@tradiephone.ai>"),
  // Inbox that receives support-chat handoff emails (blank = SMTP_FROM address).
  SUPPORT_INBOX_EMAIL: z.string().optional().default(""),

  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  TWILIO_FROM_NUMBER: z.string().optional().default(""),
  // Regulatory docs for buying numbers in regulated countries (e.g. Australia).
  // Env-only on purpose — never surfaced in the admin Settings UI. AddressSid is
  // required for AU; BundleSid is usually required too. Mobile numbers may need a
  // different bundle than local/geographic ones — set the *_MOBILE override if so.
  TWILIO_ADDRESS_SID: z.string().optional().default(""),
  TWILIO_BUNDLE_SID: z.string().optional().default(""),
  TWILIO_BUNDLE_SID_MOBILE: z.string().optional().default(""),

  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:4000/api/google/callback"),

  // S3 (object storage for branding assets — logos & favicon)
  AWS_S3_BUCKET: z.string().optional().default(""),
  AWS_S3_REGION: z.string().optional().default(""),
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
  AWS_S3_ENDPOINT: z.string().optional().default(""),
  AWS_S3_PUBLIC_URL: z.string().optional().default(""),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Integration "is it configured?" flags now live in services/settings.ts
// (DB override → env fallback). Use integrationsStatus() from there.

export const corsOrigins = env.CORS_ORIGIN.split(",").map((s) => s.trim());

/** Public base URL of the customer-facing app (no trailing slash), for login
 *  links in emails. Prefers APP_URL, then the first CORS origin, then the
 *  production URL — guaranteed non-empty so emails always carry a working link. */
export const appBaseUrl = (env.APP_URL || corsOrigins[0] || "https://agent.tradiephone.ai").replace(
  /\/$/,
  "",
);

/** Public base URL of THIS API (no trailing slash), for links that must hit the
 *  backend directly from anywhere — e.g. the email unsubscribe endpoint, which a
 *  recipient (or their mail client's one-click List-Unsubscribe) opens outside
 *  the SPA. Prefers PUBLIC_API_URL, then VAPI_SERVER_URL (both are the public API
 *  host in prod), falling back to the local dev port. */
export const publicApiBaseUrl = (
  env.PUBLIC_API_URL ||
  env.VAPI_SERVER_URL ||
  `http://localhost:${env.PORT}`
).replace(/\/$/, "");

/** Base URL for the public "More info" conversation link in the summary SMS.
 *  Prefers SHARE_LINK_BASE_URL (a brand/short domain that proxies /c/* to this
 *  API) so the SMS masks the raw API host; falls back to the API base. */
export const shareLinkBaseUrl = (env.SHARE_LINK_BASE_URL || publicApiBaseUrl).replace(/\/$/, "");
