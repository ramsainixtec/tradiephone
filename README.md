# hello22.ai — Voice Receptionist .. 

A **Vite + React 19 + TypeScript + Tailwind v4** single-page app for the
hello22.ai "24/7 AI voice receptionist" dashboard, backed by the Express + Prisma +
Postgres API in [`server/`](server/). Zustand stores hydrate from the backend (and cache
to `localStorage` between loads).
//test
> Voice/telephony targets **Vapi**; the agent voice is **Deepgram Aura-2** (played by
> Vapi's "deepgram" provider, and via /api/tts for in-app previews). "Book a Meeting"
> is a plain placeholder (no Cal.com).

## Quick start

```bash
npm run dev
```
 
That single command (root) does everything:
1. installs/refreshes deps in **both** the frontend and `server/`
2. if `server/.env` has a Postgres `DATABASE_URL`, applies the DB schema
   (`prisma migrate deploy` if migrations exist, else `prisma db push`)
3. starts the **backend** (http://localhost:4000) and **frontend**
   (http://localhost:5174) together — Ctrl+C stops both

Other scripts:
- `npm run dev:only` — frontend only (expects the backend already running)
- `npm run dev:servers` — start both servers without the install/DB step
- `npm run build`, `npm run preview`, `npm run typecheck`

## Backend required

The app always talks to the backend API. `VITE_API_URL` points the frontend at it
(defaults to `http://localhost:4000` when unset — see `.env`). Start the API from
[`server/`](server/) — see [`GO_LIVE.md`](GO_LIVE.md) for DB + integration setup. Without
a reachable backend the app shows the real `/login` screen but can't authenticate.

## Routes

| Path | Page |
|------|------|
| `/dashboard` | Voice Agent Analytics (metric cards, inline-SVG charts) |
| `/dashboard/calls` | Call Logs (table, filters, detail panel, transcript/analysis) |
| `/dashboard/assistant` | **AI Brain** — the core feature |
| `/dashboard/crm` | CRM Lead Delivery (Google Calendar, custom webhook) |
| `/dashboard/settings` | Account Settings (profile, usage, subscription, support) |
| `*` | 404 |

## The AI Brain (core)

The defensible part of the product: a friendly, section-based editor that **compiles a
structured `agent_config` into a clean LLM system prompt + voice params**, then hands that
to a live Vapi voice agent.

- Config model: [`src/types/agent.ts`](src/types/agent.ts)
- Compiler (structured config → labelled master prompt): [`src/lib/compilePrompt.ts`](src/lib/compilePrompt.ts)
- Vapi assistant payload builder: [`src/lib/vapi.ts`](src/lib/vapi.ts)
- Sections (Identity / Knowledge / Rules / Automations / Advanced):
  [`src/pages/assistant/`](src/pages/assistant/)

Edits auto-save (debounced) and recompile the master prompt live, unless you hand-edit the
prompt in **Advanced** (which pauses auto-sync until you hit *Regenerate*). Premium-gated
features (extra voices, human handover, automations) are marked with an amber **PLAN** badge.

## Structure

```
src/
  components/ui/        shadcn-style Radix primitives (button, card, dialog, …)
  components/layout/    Sidebar, AppLayout, PageHeader
  components/chat/      support chat widget
  components/assistant/ in-browser call tester (Vapi, mock-first)
  data/                 voices, mock calls/profile, default agent config
  lib/                  utils, env, compilePrompt, vapi client
  pages/                one folder per route
  stores/               Zustand stores (agent, calls, profile, crm, chat, ui)
  types/                agent_config + call + account types
```

## Design tokens

Light theme, DM Sans, brand blue `#2C76ED`. All tokens live in
[`src/index.css`](src/index.css) under Tailwind v4 `@theme` and are used via semantic
classes (`bg-primary`, `text-success`, `bg-warm`, `bg-premium-tint`, …).

## Notes / deviations

- Uses **zod 3** (not 4) for ecosystem/`@hookform/resolvers` compatibility. Bump later if needed.
- The Express + Prisma backend lives in [`server/`](server/); the frontend stores call it
  directly via [`src/lib/api.ts`](src/lib/api.ts).
