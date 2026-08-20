# API Contract — hello22.ai

Base URL: `${VITE_API_URL}` → mounted at `/api`. All JSON. Auth via `Authorization: Bearer <jwt>`.
Errors: `{ error: string, details?: unknown }` with appropriate HTTP status.

Shared helpers (already built — USE THESE, don't reinvent):
- `prisma` from `../prisma.js`
- `asyncHandler`, `HttpError`, `badRequest/unauthorized/forbidden/notFound/notImplemented` from `../lib/http.js`
- `requireAuth`, `requireAdmin` from `../middleware/auth.js` (requireAuth sets `req.user = { sub, email, role }`)
- `signToken` from `../lib/jwt.js`; `hashPassword/verifyPassword` from `../lib/password.js`
- `AgentConfig`, `compileMasterPrompt`, `DEFAULT_AGENT_CONFIG` from `../lib/agentConfig.js`
- Integration services from `../services/*` (vapi, stripe, email, sms); `integrations` flags from `../env.js`
- All route files export `default Router` (express.Router()). Use `.js` extensions on relative imports (ESM).
- Validate request bodies with zod (v3). On invalid, throw the ZodError (error middleware formats it) or `badRequest`.

## Auth — `/api/auth` (auth.routes.ts)
- `POST /register` body `{ email, password, fullName, businessName? }` → creates User(role USER) + Profile + Conversion(DEFAULT_AGENT_CONFIG) + CrmIntegration. Returns `{ token, user }`.
- `POST /login` body `{ email, password }` → `{ token, user }` (401 if bad creds).
- `GET /me` (auth) → `{ user }` where user = `{ id, email, fullName, role, profile }`.
- `POST /change-password` (auth) body `{ currentPassword, newPassword }` → `{ ok: true }` (400 if current wrong).

`user` object shape returned everywhere: `{ id, email, fullName, role, plan, profile }` (plan from profile.plan).

## Profile — `/api/profile` (profile.routes.ts, all require auth, scope to req.user.sub)
- `GET /` → the Profile row (+ derived `plan`).
- `PATCH /` body partial `{ fullName?, businessName?, mobile?, website? }` (fullName updates User.fullName). → updated profile.
- `POST /activate-number` → sets numberActivated true, returns profile.
- `GET /usage` → `{ callsHandled, minutesUsed, planMinutes, percent }` computed from this user's call logs (sum durationSec/60). planMinutes=10 for free.

## Agent config (the AI Brain) — `/api/agent` (agent.routes.ts, auth)
The Conversion row for req.user.sub is the agent record.
- `GET /` → `{ agentConfig: AgentConfig, vapiAssistantId, lastSyncedAt: updatedAt }`.
- `PUT /` body `{ agentConfig: AgentConfig }` → saves; if `agentConfig.advanced.masterPromptDirty` is false, server recompiles masterPrompt via `compileMasterPrompt`. Returns saved `{ agentConfig, lastSyncedAt }`.
- `POST /sync` (auth) → pushes the compiled assistant to Vapi via `vapi.upsertAssistant(...)`, stores returned id in `vapiAssistantId`. Returns `{ vapiAssistantId }`. If Vapi not configured → 501.
- `POST /test-token` (auth) → returns `{ publicKeyConfigured: boolean, assistant: VapiAssistantPayload }` so the FRONTEND web SDK can start a browser call with the inline assistant. (No secret leaves the server.)

## Calls — `/api/calls` (calls.routes.ts, auth; scope via the user's conversion)
- `GET /` query `{ search?, outcome?, type?, from?, to?, page?, pageSize? }` → `{ calls: CallLog[], total }` ordered by createdAt desc, limit 500.
- `GET /:id` → single call (404 if not owned).
- `GET /stats` query same filters → `{ total, successRate, avgDurationSec, missedRate }`.
- `POST /` (auth) body a CallLog draft → creates one (used by Vapi webhook/manual). 
- `POST /webhook/vapi` (NO auth — Vapi calls this) → ingests an end-of-call report, creates a CallLog under the right conversion (match by vapiAssistantId). Best-effort; always 200.

## CRM — `/api/crm` (crm.routes.ts, auth)
- `GET /` → CrmIntegration row.
- `PATCH /` body partial `{ connectedProvider?, customWebhookUrl?, googleCalendarConnected? }` → updated row.

## Chat (support widget) — `/api/chat` (chat.routes.ts, auth)
- `GET /` → `{ conversation, messages }` (creates a conversation if none).
- `POST /messages` body `{ content }` → appends user msg, generates an assistant reply (canned or via LLM later), returns both new messages.

## Billing — `/api/billing` (billing.routes.ts)
- `POST /checkout` (auth) → creates a Stripe Checkout Session for the premium price, returns `{ url }`. 501 if Stripe not configured.
- `POST /webhook` (NO auth, raw body) → Stripe webhook; on `checkout.session.completed` set the user's profile.plan = premium. Returns 200.
- `GET /portal` (auth) → Stripe billing portal url (optional; 501 if not configured).

## Admin — `/api/admin` (optional, requireAuth + requireAdmin)
- `GET /users` → list users (id, email, fullName, role, plan, createdAt).
- `GET /stats` → totals (users, calls, premium count).
