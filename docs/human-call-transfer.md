# Human Call Transfer — Reference

When a caller asks the AI to speak to a real person, the assistant transfers the
live call to the owner's configured number. If it can't connect, the AI speaks
an end message and hangs up gracefully. One number, no priority chain.

---

## Architecture

```
  Caller ─ PSTN ─▶ Vapi assistant (owner's AI receptionist)
                        │  caller asks for a human
                        │  → LLM invokes the transferCall tool
                        ▼
                  Vapi bridges the call to the owner's transfer number

  Config path (Express API + Prisma):
    routes/transfer.routes.ts   GET/PATCH settings
    services/transfer.ts        persistence + resyncAssistant()
    services/vapi.ts            buildTransferTool() + transferPromptSection()
                                → attached to the assistant on provision/sync

  React SPA:
    pages/transfer/HumanTransferPage.tsx   (route: /dashboard/transfer)
      └─ components/transfer/HumanTransferCard.tsx
      stores/useTransferStore.ts  ↔  lib/api.ts (api.transfer.get/update)
```

The AI's decision + the actual bridge are both handled by Vapi's native
`transferCall` tool. Our backend only stores the settings and injects the tool +
prompt into the assistant.

---

## Data model

`HumanTransferSettings` (one per user):

| Field | Meaning |
| --- | --- |
| `enabled` | master on/off |
| `transferNumber` | E.164 number the call is bridged to |
| `ringTimeoutSec` | how long it rings before giving up (default 25) |
| `fallbackMessage` | spoken by the AI when it can't connect |

Synced via `prisma db push` (schema.prisma is the source of truth).

---

## API (tenant bearer token)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/transfer` | settings (lazily created) |
| PATCH | `/api/transfer` | update enable / number / timeout / message |

Validation lives in `server/src/lib/transfer.ts` (`settingsPatchSchema`).

---

## How it reaches a live call

1. `buildTransferTool(plan)` builds a Vapi `transferCall` tool from the owner's
   enabled number (sanitized to clean E.164). Returns null when off / no number,
   which sends `tools: []` and strips a stale tool on PATCH.
2. `transferPromptSection(plan)` appends a **HUMAN TRANSFER** block to the system
   prompt telling the AI when to detect a human-handoff request ("talk to a
   person", "real human", "agent/representative/manager", frustration, etc.),
   to reassure first, never read the number aloud, and to speak the end message
   if it can't connect.
3. Both are attached in `buildAssistantPayload` / `upsertAssistant`.
4. `resyncAssistant(userId)` re-pushes the live assistant on every settings
   change so updates reach real calls without an AI-Brain save. Best-effort.

**Prerequisites for it to ring:** Vapi configured (Admin → Settings), a live
assistant provisioned for the owner (save the AI Brain / claim a number once),
transfer enabled, and a valid number saved.

---

## UI

`/dashboard/transfer` (sidebar entry under Call Forwarding, customer-only):
Enable toggle → Transfer number → Waiting time (10–120s) → End message.

---

## Testing

`server/src/services/vapiTransfer.test.ts` covers `buildTransferTool`
(disabled/empty/invalid → null; valid → sanitized E.164 destination) and
`transferPromptSection` (embeds the end message + intent guidance).
