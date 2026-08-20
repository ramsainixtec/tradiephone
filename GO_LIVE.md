# Go Live — real backend + DB

The SPA always talks to the Express + Prisma + Postgres backend (set by the frontend env
var `VITE_API_URL`, default `http://localhost:4000`): real JWT login, persisted agent
config, call logs, CRM, chat, billing, and a real Vapi test call (when the Vapi key is set).
The backend must be running for the app to authenticate.

## 1. Backend — configure & start

```bash
cd server
# Edit server/.env — at minimum set a REAL DATABASE_URL and a strong JWT_SECRET.
# Set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD to your chosen admin login.
# (Optional now) paste VAPI / STRIPE / SMTP / TWILIO keys to light up those features.

npm install                 # already done
npm run prisma:generate     # already done
npm run prisma:migrate      # creates tables in your Postgres (needs real DATABASE_URL)
npm run prisma:seed         # creates the admin + demo user + sample data
npm run dev                 # API on http://localhost:4000  (GET /health to verify)
```

## 2. Frontend — point it at the API

Create `.env` in the project root (next to package.json):

```
VITE_API_URL=http://localhost:4000
VITE_VAPI_PUBLIC_KEY=        # optional: your Vapi PUBLIC/browser key → real test calls
```

Then:

```bash
npm run dev                 # http://localhost:5174 — now shows a real /login screen
```

Log in with the admin (or demo) credentials you seeded. All data is now live in Postgres.

## 3. What each integration needs (optional, set in server/.env)

| Feature | Env vars | Until set |
|---|---|---|
| Real voice test call | `VITE_VAPI_PUBLIC_KEY` (frontend) | tester runs a **simulation** |
| Sync agent → Vapi assistant | `VAPI_API_KEY` (server) | `POST /api/agent/sync` → 501 |
| Upgrade / billing | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_PREMIUM`, `STRIPE_WEBHOOK_SECRET` | checkout → 501 |
| Owner email summaries | `SMTP_HOST/PORT/USER/PASS` | email send → 501 |
| Owner/client SMS | `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER` | sms send → 501 |

Features gated at 501 simply stay inert; the rest of the app works. `GET /health` returns
which integrations are currently configured.

## Stripe webhook (for auto-upgrade after payment)

Point a Stripe webhook at `POST http://<host>/api/billing/webhook` (event
`checkout.session.completed`) and set `STRIPE_WEBHOOK_SECRET`. Locally use the Stripe CLI:
`stripe listen --forward-to localhost:4000/api/billing/webhook`.
