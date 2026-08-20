# Features & Improvements — hello22.ai

## Authentication & Security
1. OTP-based registration flow — email verification with OTP input during signup
2. OTP verification in onboarding — verify email before proceeding
3. Auth state persistence — Zustand middleware to persist login across sessions
4. Password reset via OTP — email + code flow (not URL token)
5. Rate limiting — `authLimiter` on auth routes
6. Admin notification on signup — `notifyAdminsOfSignup` alerts admins of new users
7. RedirectIfAuthed — auto-redirect authenticated users away from public pages
8. AutoComplete fix — current password input set to `off`

## Onboarding
9. 6-step onboarding wizard — guided setup for new users
10. Voice selection & TTS — pick a voice and preview it during onboarding
11. Voice integration + dashboard preview — enhanced onboarding with live voice demo
12. Onboarding website step — website URL input with sheet-based UI
13. Agent request approval process — new agents require admin approval before going live

## AI Brain / Assistant
14. Section-based agent config editor — Identity, Knowledge, Rules, Automations, Advanced
15. System prompt compiler — `compilePrompt.ts` compiles config into LLM prompt
16. Vapi payload builder — `vapi.ts` builds the voice agent payload
17. VAPI public key support — enables browser-based test calls
18. AssistantTesterDialog — test your AI assistant directly from the dashboard
19. Multi-assistant support — users can have multiple conversions/assistants (jasbinder branch)
20. Agent status tracking — pending/approved status with awaiting-approval banner

## Dashboard & Analytics
21. Dashboard with 6 metric cards — key stats at a glance
22. Enhanced MetricCard & charts — improved visuals and new chart styles
23. Call Inbox — view and manage incoming calls
24. Call logging with recording URL & analysis — store recordings and AI call analysis

## Billing & Subscriptions
25. Trial subscription system — Free tier with 10 trial minutes
26. Plans management — Free ($0) and Premium ($68/week) plans
27. Billing & subscription pages — full billing UI
28. Stripe integration — payment processing with encrypted key storage
29. Fix Stripe secret key override script — admin utility for key management

## CRM & Integrations
30. CRM Lead Delivery page — `/dashboard/crm`
31. Integration architecture — Vapi, Stripe, SendGrid/SMTP, Twilio, OpenAI (all optional, degrade gracefully)

## Admin Panel
33. Admin settings & integrations management — configure platform-wide keys
34. Admin customers & subscriptions pages — manage users and their plans
35. White-label branding — `/branding` admin routes (jasbinder branch)
36. Agent request approval routes — admin can approve/reject new agents

## Reseller System
37. Reseller referral system & dashboard — reseller portal with tracking

## Account Settings
38. Enhanced SettingsPage — improved layout and component styling

## Backend / Infrastructure
39. Express + Prisma + PostgreSQL API — full backend in `server/`
40. 10 Prisma models — User, Profile, Conversion, CallLog, CrmIntegration, ChatConversation, ChatMessage, PlatformSetting, Booking
41. JWT authentication — token-based auth
42. Encrypted platform settings — integration keys stored encrypted in DB
43. Error handling improvements — surface real error messages in non-production
44. DB migrations for schema drift — status/approval fields, webhook token

## Frontend Architecture
45. React 19 + TypeScript + Vite SPA — modern frontend stack
46. Tailwind v4 with semantic tokens — `@theme` tokens in `index.css`
47. 9 Zustand stores — all persisted to localStorage
48. shadcn/Radix UI primitives — consistent component library
49. Mobile-responsive sidebar — collapsible layout for mobile
50. Landing page — public marketing page at `/`
