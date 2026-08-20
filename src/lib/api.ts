import { env } from "@/lib/env";
import type {
  AgentConfig,
  Appointment,
  BookingOverview,
  BookingSettings,
  CallIntent,
  CallLog,
  ChatMessage,
  CrmIntegration,
  EmailTemplate,
  EmailBranding,
  HumanTransferSettings,
  TransferDepartment,
  Profile,
  TranscriptTurn,
  TrialState,
  WebhookDelivery,
  WorkingHours,
} from "@/types";
import type {
  AlertEvent,
  AlertMetric,
  AlertRule,
  AlertsResponse,
  ApiCenterRegistry,
  ApiCenterSnapshot,
  ApiKeyRow,
  ApiLogPage,
  ErrorGroup,
  ProviderDetail,
  ProviderSettingRow,
  ProviderStatusPayload,
  RangeKey,
} from "@/types/apiCenter";

/* ------------------------------------------------------------------ *
 *  Typed API client. Talks to the Express backend with a Bearer token.
 * ------------------------------------------------------------------ */

export const TOKEN_KEY = "hello22_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Whether the app currently believes it has a signed-in user. Kept in sync by the
// auth store (see markSessionActive). Lets a 401 force a logout even when this
// tab's token was already cleared elsewhere (e.g. signed out in another tab) — a
// tokenless request wouldn't otherwise trip the `token`-gated logout below.
let sessionActive = false;
export function markSessionActive(active: boolean) {
  sessionActive = active;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  // For FormData bodies, let the browser set the multipart Content-Type (with boundary).
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(`${env.apiUrl}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const message = (isJson && (body as { error?: string }).error) || res.statusText;
    // A request that 401s while we have a session = it's no longer valid (deleted
    // user, revoked, or expired token) → force logout immediately. We trip this on
    // either a token being sent OR the app still showing a signed-in session, so a
    // tab whose token was cleared elsewhere (signed out in another tab) doesn't sit
    // on the dashboard silently 401ing instead of bouncing to login.
    if (res.status === 401 && (token || sessionActive)) forceLogout();
    throw new ApiError(res.status, message, isJson ? (body as { details?: unknown }).details : undefined);
  }
  return body as T;
}

/** Clear the token and bounce to /login (used when a session becomes invalid). */
function forceLogout() {
  setToken(null);
  sessionActive = false;
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.assign("/login");
  }
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, data?: unknown, init?: RequestInit) =>
  request<T>(p, {
    method: "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
    ...init,
  });
/** Multipart upload — lets the browser set the Content-Type boundary itself. */
const upload = <T>(p: string, form: FormData) =>
  request<T>(p, { method: "POST", body: form });
const put = <T>(p: string, data: unknown) =>
  request<T>(p, { method: "PUT", body: JSON.stringify(data) });
const patch = <T>(p: string, data: unknown) =>
  request<T>(p, { method: "PATCH", body: JSON.stringify(data) });
const del = <T>(p: string, data?: unknown) =>
  request<T>(p, { method: "DELETE", body: data === undefined ? undefined : JSON.stringify(data) });

/** Filters shared by the API Center Logs table and its CSV export. */
export interface ApiLogFilters {
  provider?: string;
  status?: "all" | "success" | "error";
  environment?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** Serialise log filters, dropping "all" and empty values so the URL stays readable. */
function apiLogQuery(params: ApiLogFilters): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === "all") continue;
    qs.set(key, String(value));
  }
  const q = qs.toString();
  return q ? `?${q}` : "";
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: "USER" | "ADMIN" | "STAFF" | "RESELLER";
  permissions: string[];
  /** Assigned StaffRole's display name (e.g. "Support Agent"); null for admins,
   *  customers, resellers, or a staff member with no role assigned. */
  staffRoleName?: string | null;
  plan: "free" | "premium";
  profile: Profile | null;
}
interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface AnalyzeResult {
  businessName: string;
  description: string;
  phone: string;
  email: string;
  address: string;
  services: string[];
  faqs: { question: string; answer: string }[];
  /** AI-suggested, business-specific call-handling rules → seeded into Scenario Handling. */
  scenarios?: { ifText: string; thenText: string }[];
  /** Opening/trading hours, ONLY when stated on the site — else "" (client keeps its 9–5 default). */
  businessHours?: string;
}

/** One customer-proposed industry awaiting admin review. */
export interface PendingIndustry {
  value: string;
  byEmail: string;
  byUserId: string;
  at: string;
}

/** Admin view of the custom-industry system: approved entries + pending queue. */
export interface IndustryAdminView {
  approved: string[];
  pending: PendingIndustry[];
}

export type NotificationType = "missed_call" | "new_lead" | "billing" | "agent" | "system";

/** Where typed digits must sit in a phone number — mirrors Twilio's "Match to".
 *  Keep in step with NumberMatch in server/src/services/sms.ts. */
export type NumberMatch = "start" | "anywhere" | "end";

export interface ApiNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  read: boolean;
  createdAt: string;
}

/** The visitor's IANA timezone (e.g. "Asia/Kolkata"), best-effort. Sent at signup
 *  so admin notifications can show times in the customer's own region. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Admin-managed custom scripts (SEO & tracking), injected on page load. */
export interface SeoScripts {
  head: string;
  body: string;
  footer: string;
}

export const api = {
  config: () =>
    get<{ vapiPublicKey: string; branding: Branding; scripts: SeoScripts }>("/api/config"),
  onboard: {
    analyze: (url: string) => post<AnalyzeResult>("/api/onboard/analyze", { url }),
    validate: (url: string) => post<{ reachable: boolean }>("/api/onboard/validate", { url }),
  },
  bookings: {
    create: (data: {
      topic: string;
      name: string;
      email: string;
      phone?: string;
      preferredAt?: string;
      message?: string;
    }) => post<{ ok: true; id: string }>("/api/bookings", data),
  },
  auth: {
    register: (data: { email: string; password: string; fullName: string; businessName?: string; mobile?: string; businessNumber?: string; address?: string; referralCode?: string; timezone?: string }) =>
      post<AuthResponse>("/api/auth/register", { timezone: browserTimeZone(), ...data }),
    registerStart: (data: { email: string; password: string; fullName: string; businessName?: string; mobile?: string; businessNumber?: string; address?: string; referralCode?: string; viaOnboarding?: boolean; timezone?: string }) =>
      post<{ ok: true; email: string }>("/api/auth/register/start", { timezone: browserTimeZone(), ...data }),
    registerVerify: (data: { email: string; code: string }) =>
      post<AuthResponse>("/api/auth/register/verify", data),
    registerResend: (email: string) =>
      post<{ ok: true }>("/api/auth/register/resend", { email }),
    login: (data: { email: string; password: string }) =>
      post<AuthResponse>("/api/auth/login", data),
    me: () => get<{ user: AuthUser }>("/api/auth/me"),
    forgotPassword: (email: string) =>
      post<{ ok: true }>("/api/auth/forgot-password", { email }),
    resetPassword: (data: { email: string; code: string; newPassword: string }) =>
      post<AuthResponse>("/api/auth/reset-password", data),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
      post<{ ok: true }>("/api/auth/change-password", data),
  },
  profile: {
    get: () => get<Profile>("/api/profile"),
    /** Replace this account's AI-receptionist photo. Returns the new public URL. */
    uploadAvatar: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return upload<{ assistantAvatarUrl: string }>("/api/profile/avatar", form);
    },
    /** Clear it — the platform branding avatar (or stock headshot) takes over. */
    removeAvatar: () => del<{ assistantAvatarUrl: string }>("/api/profile/avatar"),
    update: (
      data: Partial<
        Pick<
          Profile,
          | "fullName"
          | "email"
          | "businessName"
          | "mobile"
          | "website"
          | "businessNumber"
          | "country"
          | "industry"
          | "forwardingMode"
        >
      > & { forwardingConfirmed?: boolean },
    ) => patch<Profile>("/api/profile", data),
    activateNumber: () => post<Profile>("/api/profile/activate-number"),
    /** Mark the quick-setup modal seen so it never auto-opens again. */
    markQuickSetupSeen: () => post<Profile>("/api/profile/quick-setup-seen"),
    /** Save guided-onboarding progress (resume step) or mark it complete. */
    onboardingProgress: (data: { step?: number; completed?: boolean }) =>
      patch<Profile>("/api/profile/onboarding", data),
    /** Real numbers from the connected Twilio pool, each flagged taken/mine. */
    availableNumbers: () =>
      get<{
        configured: boolean;
        numbers: { number: string; taken: boolean; mine: boolean }[];
        canBuyMore: boolean;
      }>("/api/profile/available-numbers"),
    /** Reserve a pool number for this user. `country` (ISO) is the onboarding
     *  selection, persisted to drive the assistant's regional style. */
    claimNumber: (number: string, country?: string) =>
      post<Profile>("/api/profile/claim-number", { number, country }),
    /** Allowed countries (ISO) + per-country prefixes for number selection. */
    numberCountries: () =>
      get<{ countries: string[]; prefixes: Record<string, string[]> }>(
        "/api/profile/number-countries",
      ),
    /** Live Twilio monthly pricing per number type for a country. */
    numberPricing: (country: string) =>
      get<{ currency: string; prices: Record<string, number> }>(
        `/api/profile/number-pricing?country=${encodeURIComponent(country)}`,
      ),
    /** Search Twilio for brand-new, purchasable numbers (admin-gated feature).
     *  `prefix` (e.g. AU 02/03/04) narrows to a series; `q` + `match` search for
     *  digits anywhere / at the start / at the end, like Twilio's own picker. A
     *  `q` wins over `prefix` server-side — it's the more specific request. */
    searchableNumbers: (
      country: string,
      opts?: { prefix?: string; q?: string; match?: NumberMatch; limit?: number },
    ) => {
      const params = new URLSearchParams({ country });
      if (opts?.prefix) params.set("prefix", opts.prefix);
      if (opts?.q) params.set("q", opts.q);
      if (opts?.q && opts.match) params.set("match", opts.match);
      if (opts?.limit) params.set("limit", String(opts.limit));
      return get<{ numbers: string[] }>(`/api/profile/searchable-numbers?${params.toString()}`);
    },
    /** Buy a brand-new number and assign it to this user (admin-gated). `country`
     *  (ISO) is persisted to drive the assistant's regional style. */
    buyNumber: (number: string, country?: string) =>
      post<Profile>("/api/profile/buy-number", { number, country }),
    usage: () =>
      get<{
        callsHandled: number;
        minutesUsed: number;
        planMinutes: number;
        percent: number;
        unlimited: boolean;
      }>("/api/profile/usage"),
  },
  agent: {
    get: () =>
      get<{ agentConfig: AgentConfig; vapiAssistantId: string | null; status: string; lastSyncedAt: string; promptTemplate?: string; promptTemplateIsLatest?: boolean }>(
        "/api/agent",
      ),
    save: (agentConfig: AgentConfig) =>
      put<{ agentConfig: AgentConfig; lastSyncedAt: string; vapiAssistantId: string | null; status: string; synced: boolean; syncError?: string; syncQueued?: boolean }>(
        "/api/agent",
        { agentConfig },
      ),
    persist: (agentConfig: AgentConfig) =>
      post<{ agentConfig: AgentConfig; lastSyncedAt: string }>("/api/agent/persist", { agentConfig }),
    adoptLatestTemplate: () =>
      post<{ agentConfig: AgentConfig; promptTemplate: string; promptTemplateIsLatest: boolean }>("/api/agent/adopt-latest-template"),
    sync: () => post<{ vapiAssistantId: string }>("/api/agent/sync"),
    /** Build the browser test-call payload SERVER-side, so the test call runs on
     *  the same wire prompt a real inbound call does (short scaffold → summarizer
     *  → regional style) instead of a client-side compile. Pass the current draft
     *  config so unsaved AI Brain edits are still reflected. */
    testToken: (agentConfig?: AgentConfig) =>
      post<{ publicKeyConfigured: boolean; assistant: Record<string, unknown> }>(
        "/api/agent/test-token",
        agentConfig ? { agentConfig } : undefined,
      ),
    callRecording: (callId: string) =>
      get<{ recordingUrl: string | null }>(`/api/agent/call-recording/${callId}`),
  },
  voices: {
    /** Voice catalog annotated for the current user (entitlement + upsell hint). */
    list: () => get<VoiceCatalogResponse>("/api/voices"),
    listAll: () => get<AllVoicesResponse>("/api/voices/all"),
  },
  industries: {
    /** The AI-Brain industry options: built-ins + admin-approved customs. */
    list: () => get<{ industries: string[] }>("/api/industries"),
    /** Propose a custom industry — queued for admin review before it joins the list. */
    suggest: (value: string) =>
      post<{ status: "submitted" | "exists" | "pending"; value: string }>(
        "/api/industries/suggest",
        { value },
      ),
  },
  calls: {
    list: (params: Record<string, string | number | undefined> = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
      ).toString();
      return get<{ calls: CallLog[]; total: number }>(`/api/calls${qs ? `?${qs}` : ""}`);
    },
    stats: (params: Record<string, string | undefined> = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
      ).toString();
      return get<{ total: number; successRate: number; avgDurationSec: number; missedRate: number }>(
        `/api/calls/stats${qs ? `?${qs}` : ""}`,
      );
    },
    get: (id: string) => get<CallLog>(`/api/calls/${id}`),
    create: (
      data: {
        type?: "Web" | "Phone";
        callerName?: string;
        callerNumber?: string;
        durationSec?: number;
        outcome?: "completed" | "missed" | "failed" | "voicemail";
        summary?: string;
        recordingUrl?: string;
        transcript?: unknown;
        analysis?: unknown;
      },
      // `keepalive` lets the request finish even if the page is unloading (a web
      // call saved on hang-up must survive an immediate refresh so its history +
      // minutes aren't lost).
      opts?: { keepalive?: boolean },
    ) => post<CallLog>("/api/calls", data, opts?.keepalive ? { keepalive: true } : undefined),
    attachRecording: (id: string, recordingUrl: string) =>
      patch<CallLog>(`/api/calls/${id}`, { recordingUrl }),
    /** Enrich a just-saved web call with the AI summary (and recording) computed
     *  a moment after the fast, refresh-safe initial save. */
    update: (id: string, data: { summary?: string; recordingUrl?: string; analysis?: unknown }) =>
      patch<CallLog>(`/api/calls/${id}`, data),
    /** Correct a call's category. The server stamps it as owner-set so no later
     *  AI pass overwrites it. */
    setIntent: (id: string, intent: CallIntent) =>
      patch<CallLog>(`/api/calls/${id}/intent`, { intent }),
    summarize: (transcript: TranscriptTurn[]) =>
      post<{ summary: string }>("/api/calls/summarize", { transcript }),
    /** Translate a call's summary + transcript into the owner's report language
     *  (transcript cached server-side). `lang` is "" when no translation applies. */
    translate: (id: string) =>
      post<{ lang: string; transcript: TranscriptTurn[]; summary: string }>(
        `/api/calls/${id}/translate`,
      ),
    recording: (vapiCallId: string) =>
      get<{ recordingUrl: string | null }>(`/api/calls/recording?vapiCallId=${encodeURIComponent(vapiCallId)}`),
    /** A freshly-signed, short-lived proxy URL for playing this call's recording.
     *  The <audio> element can't send an auth header, so the URL itself is the
     *  capability — minted here (authenticated + scoped to the owner's calls). */
    /** `share: true` mints a longer-lived link meant to be sent to someone else
     *  (a client, a colleague) — the dashboard's own token is deliberately short
     *  because it is re-minted on every open, which would strand a pasted link.
     *  `expiresInDays` comes back so the UI can state the window truthfully. */
    recordingUrl: (id: string, share = false) =>
      get<{ url: string | null; expiresInDays?: number }>(
        `/api/calls/${id}/recording-url${share ? "?share=1" : ""}`,
      ),
  },
  notifications: {
    list: () => get<{ notifications: ApiNotification[]; unreadCount: number }>("/api/notifications"),
    markRead: (id: string) => post<{ ok: true }>(`/api/notifications/${id}/read`),
    markAllRead: () => post<{ ok: true }>("/api/notifications/read-all"),
    clear: () => del<{ ok: true }>("/api/notifications"),
    /** Which plan features the user has (email always true; customCrm gates webhook CRM). */
    channels: () =>
      get<{
        email: boolean;
        sms: boolean;
        smsToCaller: boolean;
        whatsapp: boolean;
        customCrm: boolean;
        multilingual: boolean;
      }>("/api/notifications/channels"),
    /** Send a dummy call-summary to the given destination to verify the channel works. */
    testSummary: (channel: "email" | "sms" | "whatsapp", to: string) =>
      post<{ ok: true; to: string }>("/api/notifications/test-summary", { channel, to }),
  },
  trial: {
    status: () => get<{ success: boolean } & TrialState>("/api/trial/status"),
  },
  crm: {
    get: () => get<CrmIntegration>("/api/crm"),
    update: (data: Partial<CrmIntegration>) => patch<CrmIntegration>("/api/crm", data),
    testWebhook: () =>
      post<{ success: boolean; status: number; errorMessage: string; durationMs: number }>(
        "/api/crm/test-webhook",
      ),
    deliveries: (page = 1, pageSize = 20) =>
      get<{ deliveries: WebhookDelivery[]; total: number }>(
        `/api/crm/deliveries?page=${page}&pageSize=${pageSize}`,
      ),
  },
  transfer: {
    get: () => get<HumanTransferSettings>("/api/transfer"),
    update: (
      data: Partial<
        Pick<
          HumanTransferSettings,
          "enabled" | "transferNumber" | "ringTimeoutSec" | "fallbackMessage"
        >
      >,
    ) => patch<HumanTransferSettings>("/api/transfer", data),
    departments: {
      list: () => get<TransferDepartment[]>("/api/transfer/departments"),
      /** Replace the whole department list in one atomic save. */
      replace: (
        departments: Pick<
          TransferDepartment,
          "name" | "number" | "description" | "enabled" | "ringTimeoutSec" | "fallbackMessage"
        >[],
      ) => put<TransferDepartment[]>("/api/transfer/departments", { departments }),
    },
  },
  google: {
    authUrl: () => get<{ url: string }>("/api/google/auth-url"),
    status: () => get<{ connected: boolean; email?: string }>("/api/google/status"),
    disconnect: () => post<{ ok: true }>("/api/google/disconnect"),
    /** Create + delete a test event to verify the calendar connection works. */
    test: () => post<{ ok: boolean; message: string }>("/api/google/test"),
  },
  booking: {
    overview: () => get<BookingOverview>("/api/booking/overview"),
    appointments: (params: { from?: string; to?: string; status?: string } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v) as [string, string][],
      ).toString();
      return get<{ appointments: Appointment[] }>(`/api/booking/appointments${qs ? `?${qs}` : ""}`);
    },
    createAppointment: (data: {
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
      notes?: string;
      startAt: string;
      endAt?: string;
    }) => post<Appointment>("/api/booking/appointments", data),
    cancelAppointment: (id: string) =>
      post<Appointment>(`/api/booking/appointments/${id}/cancel`),
    rescheduleAppointment: (id: string, data: { startAt: string; endAt?: string }) =>
      post<Appointment>(`/api/booking/appointments/${id}/reschedule`, data),
    settings: () => get<BookingSettings>("/api/booking/settings"),
    saveSettings: (data: {
      autoBookEnabled?: boolean;
      durationMin?: number;
      calendarId?: string;
      timezone?: string;
      hours?: WorkingHours;
    }) => put<BookingSettings & { synced: boolean }>("/api/booking/settings", data),
    /** Live booking tools + prompt for the browser test call. */
    toolConfig: () =>
      get<{ enabled: boolean; tools: unknown[]; promptSection: string }>(
        "/api/booking/tool-config",
      ),
  },
  chat: {
    get: () => get<{ conversation: { id: string }; messages: ChatMessage[] }>("/api/chat"),
    send: (content: string) => post<{ messages: ChatMessage[] }>("/api/chat/messages", { content }),
  },
  billing: {
    /** Stripe customer portal URL — 400s if the user has no Stripe customer yet. */
    portal: () => get<{ url: string }>("/api/billing/portal"),
    /** Public — active plans for the signup picker. */
    plans: () => get<SubscriptionPlan[]>("/api/billing/plans"),
    /** Public — the global free-trial terms (days + minutes) for the subscribe page. */
    trialInfo: () => get<{ days: number; minutes: number }>("/api/billing/trial-info"),
    /** Check a coupon code against a plan. Read-only — reserves nothing, so it's
     *  safe to call as the user types. */
    validateCoupon: (code: string, planId: string) =>
      post<CouponValidation>("/api/billing/coupon/validate", { code, planId }),
    /** Start a trial subscription on the chosen plan; returns a SetupIntent client secret.
     *  A `couponCode` is re-validated server-side and rejected outright if it no
     *  longer applies — nobody should reach the card step expecting a discount
     *  that isn't there. */
    subscribe: (planId: string, autoRenew = true, couponCode?: string) =>
      post<{ clientSecret: string | null; subscriptionId: string }>("/api/billing/subscribe", {
        planId,
        autoRenew,
        ...(couponCode ? { couponCode } : {}),
      }),
    /** Confirm the saved card + activate the plan. `charged` = the free trial was
     *  used up so the card was billed now (vs a trial that just started/continued). */
    /** `activateNow` = the user explicitly bought a plan, so charge and activate
     *  immediately rather than continuing their free trial. */
    confirmCard: (paymentMethodId: string, activateNow?: boolean) =>
      post<{ ok: true; charged: boolean }>("/api/billing/confirm-card", {
        paymentMethodId,
        ...(activateNow ? { activateNow } : {}),
      }),
    /** Subscription details for the settings page. */
    subscription: () => get<{ subscription: SubscriptionDetail | null }>("/api/billing/subscription"),
    /** Turn auto-renew (auto-charge on expiry) on/off. */
    setAutoRenew: (enabled: boolean) =>
      post<{ ok: true; autoRenew: boolean; message: string }>("/api/billing/auto-renew", { enabled }),
    /** Renew the current (blocked) plan now — charges the saved card, resets
     *  minutes, turns auto-renew back on. Keeps the same plan (no trial). */
    renew: () => post<{ ok: true; message: string }>("/api/billing/renew"),
    /** Recent invoices from Stripe. */
    invoices: () => get<{ invoices: Invoice[] }>("/api/billing/invoices"),
    /** Preview a plan change — credit + exact amount due + effective date. No charge. */
    changePlanPreview: (planId: string) =>
      post<PlanChangePreview>("/api/billing/change-plan/preview", { planId }),
    /** Apply a plan change (upgrade now / downgrade at period end / swap trial plan). */
    changePlan: (planId: string) =>
      post<{ ok: true; direction: string; message: string; chargedCents?: number; creditCents?: number }>(
        "/api/billing/change-plan",
        { planId },
      ),
    /** Cancel a pending downgrade — stay on the current plan. */
    cancelDowngrade: () =>
      post<{ ok: true; message: string }>("/api/billing/change-plan/cancel-downgrade"),
  },
  admin: {
    overview: () => get<AdminOverview>("/api/admin/overview"),
    customers: (search?: string) =>
      get<Customer[]>(`/api/admin/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    customer: (id: string) => get<Customer>(`/api/admin/customers/${id}`),
    updateCustomer: (id: string, data: { plan?: "free" | "premium" }) =>
      patch<Customer>(`/api/admin/customers/${id}`, data),
    deleteCustomer: (id: string) => del<{ ok: true }>(`/api/admin/customers/${id}`),
    suspendCustomer: (id: string, reason?: string) =>
      post<Customer>(`/api/admin/customers/${id}/suspend`, reason ? { reason } : undefined),
    reactivateCustomer: (id: string) => post<Customer>(`/api/admin/customers/${id}/reactivate`),
    /** The PIN is verified server-side inside this endpoint — sending it is not
     *  a formality the client could skip. */
    impersonate: (id: string, pin: string) =>
      post<{ token: string; user: AuthUser }>(`/api/admin/customers/${id}/impersonate`, { pin }),
    impersonationPin: {
      status: () => get<{ isDefault: boolean; lockedForMs: number }>("/api/admin/impersonation-pin"),
      change: (currentPin: string, newPin: string) =>
        put<{ ok: true; isDefault: false }>("/api/admin/impersonation-pin", {
          currentPin,
          newPin,
        }),
      /** Emails a one-time code to the admin's OWN address — the server reads it
       *  from the session, so there is nothing to pass here. */
      startReset: () =>
        post<{ ok: true; sentTo: string }>("/api/admin/impersonation-pin/reset/start"),
      completeReset: (code: string, newPin: string) =>
        post<{ ok: true; isDefault: false }>("/api/admin/impersonation-pin/reset/complete", {
          code,
          newPin,
        }),
    },
    subscriptions: {
      list: () => get<AdminSubscriptionsResponse>("/api/admin/subscriptions"),
      detail: (userId: string) =>
        get<AdminSubscriptionDetail>(`/api/admin/subscriptions/${userId}`),
    },
    integrations: () => get<IntegrationView[]>("/api/admin/integrations"),
    saveIntegrations: (updates: Record<string, string>) =>
      put<IntegrationView[]>("/api/admin/integrations", { updates }),
    clearIntegration: (id: string) =>
      del<IntegrationView[]>(`/api/admin/integrations/${id}`),
    coupons: {
      list: () => get<Coupon[]>("/api/admin/coupons"),
      redemptions: (id: string) =>
        get<CouponRedemptionRow[]>(`/api/admin/coupons/${id}/redemptions`),
      create: (data: CouponInput) => post<Coupon>("/api/admin/coupons", data),
      update: (id: string, data: Partial<CouponInput>) =>
        patch<Coupon>(`/api/admin/coupons/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/coupons/${id}`),
      /** The customer's live discount + every active coupon annotated with
       *  whether it can be granted to them. One call for the Discount card. */
      forCustomer: (userId: string) =>
        get<CustomerCouponState>(`/api/admin/customers/${userId}/coupon`),
      /** Give one customer a coupon directly (retention / comp). `override` is
       *  required for a coupon outside its redemption window or restricted to
       *  other plans — the server refuses without it, so neither can go out
       *  unnoticed. */
      grant: (userId: string, couponId: string, override = false) =>
        post<{ ok: true }>(`/api/admin/customers/${userId}/coupon`, {
          couponId,
          ...(override ? { override: true } : {}),
        }),
      /** Remove a customer's live discount. `releaseSlot` lets them redeem that
       *  code again — the undo for a coupon granted by mistake. */
      revoke: (userId: string, releaseSlot = false) =>
        del<{ ok: true; releaseSlot: boolean }>(
          `/api/admin/customers/${userId}/coupon?releaseSlot=${releaseSlot}`,
        ),
    },
    voiceCategories: {
      list: () => get<VoiceCategory[]>("/api/admin/voice-categories"),
      create: (title: string, voiceIds: string[]) =>
        post<VoiceCategory>("/api/admin/voice-categories", { title, voiceIds }),
      update: (id: string, title: string, voiceIds: string[]) =>
        put<VoiceCategory>(`/api/admin/voice-categories/${id}`, { title, voiceIds }),
      remove: (id: string) => del<{ ok: boolean }>(`/api/admin/voice-categories/${id}`),
    },
    testEmail: (to?: string) =>
      post<{ success: boolean; to?: string; message?: string }>(
        "/api/admin/integrations/email/test",
        to ? { to } : {},
      ),
    branding: {
      get: () => get<BrandingState>("/api/admin/branding"),
      upload: (slot: BrandingSlot, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return upload<BrandingState>(`/api/admin/branding/${slot}`, form);
      },
      clear: (slot: BrandingSlot) => del<BrandingState>(`/api/admin/branding/${slot}`),
    },
    emails: {
      list: () =>
        get<{ templates: EmailTemplate[]; branding: EmailBranding }>("/api/admin/emails"),
      update: (key: string, data: Partial<Pick<EmailTemplate, "subject" | "body" | "enabled">>) =>
        patch<EmailTemplate>(`/api/admin/emails/${key}`, data),
      preview: (key: string) =>
        get<{ subject: string; html: string; text: string; enabled: boolean; alwaysOn: boolean }>(
          `/api/admin/emails/${key}/preview`,
        ),
      test: (key: string, to?: string) =>
        post<{ success: boolean; to?: string }>(`/api/admin/emails/${key}/test`, to ? { to } : {}),
      saveBranding: (data: Partial<EmailBranding>) =>
        put<EmailBranding>("/api/admin/email-branding", data),
    },
    testNexleonCrm: () =>
      post<{ success: boolean; status: number; errorMessage: string; durationMs: number }>(
        "/api/admin/integrations/perfex/test",
      ),
    testWhatsApp: (to: string) =>
      post<{ success: boolean; message: string }>(
        "/api/admin/integrations/whatsapp/test",
        { to },
      ),
    verifyWhatsApp: () =>
      post<{ success: boolean; message: string }>("/api/admin/integrations/whatsapp/verify"),
    whatsAppInfo: () =>
      get<{ webhookUrl: string }>("/api/admin/integrations/whatsapp/info"),
    plans: {
      list: () => get<SubscriptionPlan[]>("/api/admin/plans"),
      create: (data: PlanInput) => post<SubscriptionPlan>("/api/admin/plans", data),
      update: (id: string, data: Partial<PlanInput>) =>
        patch<SubscriptionPlan>(`/api/admin/plans/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/plans/${id}`),
      syncStripe: () =>
        post<{ results: Array<{ id: string; name: string; synced: boolean; error?: string }> }>(
          "/api/admin/plans/sync-stripe",
        ),
    },
    trialDays: {
      get: () => get<{ days: number }>("/api/admin/trial-days"),
      set: (days: number) => put<{ days: number }>("/api/admin/trial-days", { days }),
    },
    trialMinutes: {
      get: () => get<{ minutes: number }>("/api/admin/trial-minutes"),
      set: (minutes: number) => put<{ minutes: number }>("/api/admin/trial-minutes", { minutes }),
    },
    gracePeriod: {
      get: () => get<{ enabled: boolean; days: number }>("/api/admin/grace-period"),
      set: (enabled: boolean, days: number) =>
        put<{ enabled: boolean; days: number }>("/api/admin/grace-period", { enabled, days }),
    },
    /** Platform-wide ceiling on how long any single call may run. Stored in
     *  seconds; the UI edits minutes. */
    callDurationCap: {
      get: () => get<{ enabled: boolean; seconds: number }>("/api/admin/call-duration-cap"),
      set: (enabled: boolean, seconds: number) =>
        put<{ enabled: boolean; seconds: number }>("/api/admin/call-duration-cap", {
          enabled,
          seconds,
        }),
    },
    promptTemplate: {
      get: () =>
        get<{ template: string; default: string; isDefault: boolean; preview: string }>(
          "/api/admin/prompt-template",
        ),
      set: (template: string) =>
        put<{ template: string; default: string; isDefault: boolean; preview: string }>(
          "/api/admin/prompt-template",
          { template },
        ),
      history: () =>
        get<{
          versions: {
            id: number;
            template: string;
            isDefault: boolean;
            chars: number;
            replacedAt: string;
            replacedBy: string;
          }[];
        }>("/api/admin/prompt-template/history"),
    },
    seo: {
      get: () => get<{ scripts: SeoScripts }>("/api/admin/seo"),
      set: (scripts: SeoScripts) => put<{ scripts: SeoScripts }>("/api/admin/seo", { scripts }),
    },
    countryStyles: {
      get: () =>
        get<{ styles: Record<string, string>; builtins: Record<string, string> }>(
          "/api/admin/country-styles",
        ),
      set: (styles: Record<string, string>) =>
        put<{ styles: Record<string, string>; builtins: Record<string, string> }>(
          "/api/admin/country-styles",
          { styles },
        ),
    },
    industries: {
      /** Approved custom entries + the pending-review queue. */
      list: () => get<IndustryAdminView>("/api/admin/industries"),
      /** Approve a pending suggestion → it joins the public list. */
      approve: (value: string) => post<IndustryAdminView>("/api/admin/industries/approve", { value }),
      /** Reject (drop) a pending suggestion. */
      reject: (value: string) => post<IndustryAdminView>("/api/admin/industries/reject", { value }),
      /** Remove a previously-approved custom industry (built-ins stay). */
      remove: (value: string) => del<IndustryAdminView>("/api/admin/industries", { value }),
    },
    agentDefaultNames: {
      get: () => get<{ male: string; female: string }>("/api/admin/agent-default-names"),
      set: (male: string, female: string) =>
        put<{ male: string; female: string }>("/api/admin/agent-default-names", { male, female }),
    },
    agentLlm: {
      // Providers/models are fetched live from Vapi server-side; `refresh` forces
      // the server to bypass its cache and re-pull Vapi's current catalogue.
      get: (refresh = false) =>
        get<AgentLlmSettings>(`/api/admin/agent-llm${refresh ? "?refresh=true" : ""}`),
      set: (provider: string, model: string) =>
        put<AgentLlmSettings>("/api/admin/agent-llm", { provider, model }),
    },
    transcriberFallback: {
      // Transcriber options refresh live from Vapi; `refresh` forces a re-pull.
      get: (refresh = false) =>
        get<TranscriberFallbackSettings>(
          `/api/admin/transcriber-fallback${refresh ? "?refresh=true" : ""}`,
        ),
      set: (data: { autoFallback: boolean; provider: string; model: string }) =>
        put<TranscriberFallbackSettings>("/api/admin/transcriber-fallback", data),
    },
    /** Onboarding policy. `cardRequired` applies to NEW signups only — every
     *  account snapshots it at creation, so changing it never affects anyone
     *  already signed up. */
    onboarding: {
      get: () => get<{ cardRequired: boolean }>("/api/admin/onboarding"),
      set: (cardRequired: boolean) =>
        put<{ cardRequired: boolean }>("/api/admin/onboarding", { cardRequired }),
    },
    resellers: {
      list: () => get<Reseller[]>("/api/admin/resellers"),
      create: (data: { email: string; fullName: string; password: string; commissionPercent: number }) =>
        post<Reseller>("/api/admin/resellers", data),
      update: (id: string, data: { fullName?: string; commissionPercent?: number }) =>
        patch<Reseller>(`/api/admin/resellers/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/resellers/${id}`),
    },
    audit: (
      params: {
        action?: string;
        search?: string;
        from?: string;
        to?: string;
        page?: number;
        pageSize?: number;
      } = {},
    ) => {
      const qs = new URLSearchParams();
      if (params.action) qs.set("action", params.action);
      if (params.search) qs.set("search", params.search);
      if (params.from) qs.set("from", params.from);
      if (params.to) qs.set("to", params.to);
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      const q = qs.toString();
      return get<AuditLogPage>(`/api/admin/audit${q ? `?${q}` : ""}`);
    },
    webhookDeliveries: (status: WebhookDeliveryStatus = "all", limit = 100) =>
      get<WebhookDeliveryLog[]>(`/api/admin/webhook-deliveries?status=${status}&limit=${limit}`),
    retryWebhook: (id: string) =>
      post<{ success: boolean; status: number; errorMessage: string; durationMs: number }>(
        `/api/admin/webhook-deliveries/${id}/retry`,
      ),
    systemHealth: () => get<SystemHealth>("/api/admin/system-health"),
    customerDetail: (id: string) => get<CustomerDetail>(`/api/admin/customers/${id}/detail`),
    sendDigests: () => post<{ sent: number; skipped: number }>("/api/admin/reports/send-digests"),
    reportsLastRun: () => get<{ lastRunAt: string | null }>("/api/admin/reports/last-run"),
    previewDigest: (userId: string) => get<UserDigest>(`/api/admin/reports/preview/${userId}`),
    phoneNumbers: {
      overview: () => get<PhoneOverview>("/api/admin/phones/overview"),
      agents: () => get<PhoneAgent[]>("/api/admin/phones/agents"),
      twilioAvailable: () => get<PhoneImportable[]>("/api/admin/phones/twilio-available"),
      twilioSearch: (params: {
        country?: string;
        areaCode?: string;
        contains?: string;
        type?: "local" | "mobile";
        prefix?: string;
      }) => {
        const q = new URLSearchParams(
          Object.entries(params).filter(([, v]) => v) as [string, string][],
        ).toString();
        return get<PhoneImportable[]>(`/api/admin/phones/twilio-search${q ? `?${q}` : ""}`);
      },
      addSystem: (data: { number: string; sid?: string; purchase?: boolean }) =>
        post<PhonePoolNumber>("/api/admin/phones/add-system", data),
      reassign: (id: string, agentId: string | null) =>
        post<PhoneOverview>(`/api/admin/phones/${id}/reassign`, agentId ? { agentId } : {}),
      assignSms: (number: string) =>
        post<{ smsSender: string }>("/api/admin/phones/assign-sms", { number }),
      unassignSms: () => post<{ smsSender: null }>("/api/admin/phones/unassign-sms"),
      testSms: (to: string) =>
        post<{ ok: true; from: string; to: string }>("/api/admin/phones/test-sms", { to }),
      cleanupOrphaned: () =>
        post<{ removed: number; numbers: string[] }>("/api/admin/phones/cleanup-orphaned"),
      clearSync: () =>
        post<{ changed: number; numbers: string[] }>("/api/admin/phones/clear-sync"),
      resyncTwilio: () =>
        post<PhoneResync>("/api/admin/phones/resync-twilio"),
      replenishConfig: () => get<PhoneReplenishConfig>("/api/admin/phones/replenish-config"),
      saveReplenishConfig: (data: Partial<PhoneReplenishConfig>) =>
        put<PhoneReplenishConfig>("/api/admin/phones/replenish-config", data),
      replenish: () => post<PhoneReplenishResult>("/api/admin/phones/replenish"),
    },
    staff: {
      list: () => get<StaffMember[]>("/api/admin/staff"),
      get: (id: string) => get<StaffMember>(`/api/admin/staff/${id}`),
      create: (data: {
        email: string;
        fullName: string;
        password: string;
        roleId?: string;
        permissions?: string[];
      }) => post<StaffMember>("/api/admin/staff", data),
      update: (
        id: string,
        data: { fullName?: string; roleId?: string | null; permissions?: string[] },
      ) => patch<StaffMember>(`/api/admin/staff/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/staff/${id}`),
      permissions: () => get<PermissionsConfig>("/api/admin/permissions"),
    },
    roles: {
      list: () => get<StaffRole[]>("/api/admin/roles"),
      get: (id: string) => get<StaffRole>(`/api/admin/roles/${id}`),
      create: (data: { name: string; description?: string; permissions: string[] }) =>
        post<StaffRole>("/api/admin/roles", data),
      update: (
        id: string,
        data: { name?: string; description?: string; permissions?: string[] },
      ) => patch<StaffRole>(`/api/admin/roles/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/roles/${id}`),
    },

    /* ----------------------------- API Center ------------------------- */
    /**
     * Admin → API Center. `snapshot` is deliberately one fat call: the Overview,
     * Connections, Health, Quotas, Costs and Latency screens are all views of the
     * same provider rows, and fetching per-screen would show six slightly
     * different moments in time.
     */
    apiCenter: {
      snapshot: (range: RangeKey = "24h", environment = "all") =>
        get<ApiCenterSnapshot>(
          `/api/admin/api-center/snapshot?range=${range}&environment=${encodeURIComponent(environment)}`,
        ),
      registry: () => get<ApiCenterRegistry>("/api/admin/api-center/registry"),
      provider: (id: string, range: RangeKey = "24h") =>
        get<ProviderDetail>(`/api/admin/api-center/providers/${encodeURIComponent(id)}?range=${range}`),
      refreshStatus: (id: string) =>
        post<ProviderStatusPayload>(`/api/admin/api-center/providers/${encodeURIComponent(id)}/refresh-status`),

      settings: () => get<ProviderSettingRow[]>("/api/admin/api-center/settings"),
      saveSettings: (
        provider: string,
        data: {
          monthlyQuota?: number;
          unitCostUsd?: number | null;
          rateLimitPerMin?: number;
          environment?: "production" | "sandbox";
          keyExpiresAt?: string | null;
          muted?: boolean;
          notes?: string;
        },
      ) => put<ProviderSettingRow>(`/api/admin/api-center/settings/${encodeURIComponent(provider)}`, data),

      keys: () => get<ApiKeyRow[]>("/api/admin/api-center/keys"),
      incidents: () => get<ProviderStatusPayload[]>("/api/admin/api-center/incidents"),

      logs: (params: ApiLogFilters = {}) =>
        get<ApiLogPage>(`/api/admin/api-center/logs${apiLogQuery(params)}`),
      /** Absolute URL so the browser can download it directly (auth via token in
       *  the header isn't possible on a plain link — see logsCsv usage). */
      logsCsvPath: (params: ApiLogFilters = {}) => `/api/admin/api-center/logs.csv${apiLogQuery(params)}`,

      errors: (range: RangeKey = "24h", provider = "all") =>
        get<{ range: RangeKey; groups: ErrorGroup[] }>(
          `/api/admin/api-center/errors?range=${range}&provider=${encodeURIComponent(provider)}`,
        ),

      alerts: (status: "open" | "all" = "open") =>
        get<AlertsResponse>(`/api/admin/api-center/alerts?status=${status}`),
      createRule: (data: {
        provider?: string | null;
        metric: AlertMetric;
        comparator?: "gt" | "lt";
        threshold: number;
        windowMin?: number;
        severity?: "warning" | "critical";
        enabled?: boolean;
        cooldownMin?: number;
      }) => post<AlertRule[]>("/api/admin/api-center/alerts/rules", data),
      updateRule: (
        id: string,
        data: Partial<{
          provider: string | null;
          metric: AlertMetric;
          comparator: "gt" | "lt";
          threshold: number;
          windowMin: number;
          severity: "warning" | "critical";
          enabled: boolean;
          cooldownMin: number;
        }>,
      ) => patch<AlertRule[]>(`/api/admin/api-center/alerts/rules/${id}`, data),
      deleteRule: (id: string) => del<AlertRule[]>(`/api/admin/api-center/alerts/rules/${id}`),
      acknowledgeAlert: (id: string) => post<AlertEvent[]>(`/api/admin/api-center/alerts/${id}/acknowledge`),
      resolveAlert: (id: string) => post<AlertEvent[]>(`/api/admin/api-center/alerts/${id}/resolve`),
    },
  },
  reseller: {
    overview: () => get<ResellerOverview>("/api/reseller/overview"),
    customerDetail: (id: string) =>
      get<ResellerCustomerDetail>(`/api/reseller/customers/${id}`),
  },
};

export type PhoneNumberStatus = "active" | "pending" | "inactive";

export interface PhonePoolNumber {
  id: string;
  number: string;
  status: PhoneNumberStatus;
  poolStatus: string; // AVAILABLE | ASSIGNED | PENDING_APPROVAL
  purchasePriceCents: number;
  monthlyPriceCents: number;
  addedAt: string;
}
export interface PhoneUserNumber extends PhonePoolNumber {
  agentName: string;
  agentProvider: string;
  agentId: string | null;
  userEmail: string;
}
export interface PhoneOverview {
  pool: PhonePoolNumber[];
  userNumbers: PhoneUserNumber[];
  smsSender: string | null;
}
export interface PhoneAgent {
  id: string;
  name: string;
  provider: string;
  userEmail: string;
  autoRoutes: boolean;
}
export interface PhoneImportable {
  sid: string;
  number: string;
  monthlyPriceCents: number;
}
export interface PhoneResync {
  configured: boolean;
  purged: number;
  owned: number;
  inPool: number;
  missing: number;
  assignmentsSynced: number;
}
export interface PhoneReplenishConfig {
  target: number;
  autoPurchase: boolean;
  country: string;
  /** Let customers buy a brand-new number during setup. */
  userPurchase: boolean;
  /** ISO codes of countries customers may pick a number from during setup. */
  allowedCountries: string[];
  /** Per-country national prefixes customers may pick (iso → prefix[]). */
  allowedPrefixes: Record<string, string[]>;
}
export interface PhoneReplenishResult {
  target: number;
  before: number;
  imported: number;
  purchased: number;
  available: number;
  autoPurchase: boolean;
  skipped?: string;
}

export interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  permissions: string[];
  createdAt: string;
  /** Assigned role (RBAC). Null when the member has custom/no permissions. */
  roleId: string | null;
  roleName: string | null;
}

/** A table column that can be individually gated within a section. */
export interface FieldDef {
  key: string;
  label: string;
}

export interface SectionDef {
  key: string;
  label: string;
  capabilities: string[];
  /** Column-level sub-permissions for this section's data table. */
  fields?: FieldDef[];
}

export interface CapabilityDef {
  key: string;
  label: string;
}

export interface PermissionsConfig {
  sections: SectionDef[];
  capabilities: CapabilityDef[];
}

export interface StaffRole {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  memberCount: number;
  createdAt: string;
}

export interface Reseller {
  id: string;
  email: string;
  fullName: string;
  referralCode: string | null;
  commissionPercent: number;
  referredCount: number;
  createdAt: string;
  earnedCents: number;
  pendingCents: number;
}

export interface ResellerOverview {
  referralCode: string | null;
  commissionPercent: number;
  referredCount: number;
  earnedCents: number;
  pendingCents: number;
  customers: {
    id: string;
    name: string;
    plan: "free" | "premium";
    subscriptionStatus: string;
    joinedAt: string;
    commissionCents: number;
  }[];
}

/** Full detail for one referred customer (contact + subscription + this
 *  reseller's commission history). No operational/payment internals. */
export interface ResellerCustomerDetail {
  id: string;
  name: string;
  fullName: string;
  email: string;
  businessName: string;
  mobile: string;
  website: string;
  businessNumber: string;
  plan: "free" | "premium";
  subscriptionStatus: string;
  joinedAt: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  commission: { totalCents: number; paidCents: number; pendingCents: number };
  commissionHistory: {
    amountCents: number;
    percent: number;
    invoiceAmountCents: number;
    status: string;
    createdAt: string;
  }[];
}

export type BillingInterval = "week" | "month" | "year";

/** A single voice in the AI-Brain picker (from the Deepgram voice catalog). */
export interface VoiceCatalogItem {
  id: string;
  name: string;
  descriptor: string;
  region: string;
  previewUrl: string | null;
  /** Male/Female label — from the catalog (Deepgram) or ElevenLabs voice labels;
   *  null/absent when the provider doesn't say. */
  gender?: "male" | "female" | null;
  /** ISO 639-1 code for the curated single-language voices (Chinese "zh", Punjabi
   *  "pa"). Absent on the premade/Deepgram voices, which aren't language-specific. */
  language?: string;
  /** Whether the current user's plan lets them select (not just preview) it. */
  entitled: boolean;
  /** Plan(s) that unlock this voice — shown as an upsell hint when locked. */
  plans: string[];
}

export interface VoiceCatalogItemWithProvider extends VoiceCatalogItem {
  provider?: "deepgram" | "elevenlabs";
}

export interface VoiceCatalogResponse {
  voices: VoiceCatalogItemWithProvider[];
  /** The voice the agent is currently on (for display even when locked). */
  current?: VoiceCatalogItemWithProvider | null;
  /** True when the user can't change voice yet (trial / no active plan / plan without
   *  a Voice Bank category) — they stay on the default voice. */
  locked?: boolean;
  /** The Voice Bank category title the user's plan unlocks (when unlocked). */
  category?: string | null;
  currentPlanName: string | null;
}

/** A voice option in a specific provider's catalog (admin Voice Bank / plan editor). */
export interface ProviderVoice {
  id: string;
  name: string;
  descriptor: string;
  region: string;
  previewUrl: string | null;
  /** Male/Female label (see VoiceCatalogItem). */
  gender?: "male" | "female" | null;
  /** ISO 639-1 code for the curated single-language voices (see VoiceCatalogItem). */
  language?: string;
}

export interface AllVoicesResponse {
  deepgram: ProviderVoice[];
  elevenlabs: ProviderVoice[];
}

/** A Voice Bank category (admin-curated named set of voices, both providers). */
export interface VoiceCategory {
  id: string;
  title: string;
  voiceIds: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  displayName: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: BillingInterval;
  includedMinutes: number;
  features: string[];
  smsEnabled: boolean;
  /** "SMS to Caller" — the AI texts callers details they ask for mid-call. */
  smsToCallerEnabled: boolean;
  whatsappEnabled: boolean;
  /** Custom CRM (webhook) lead delivery is included in this plan. */
  customCrmEnabled: boolean;
  /** The assistant may answer in the caller's language (languages picked in the AI Brain). */
  multilingualEnabled: boolean;
  /** "Summary, Transcript & Recording" bullet is advertised for this plan. */
  transcriptsEnabled: boolean;
  allowedVoices: string[]; // deprecated
  /** Voice Bank category this plan unlocks (null = customers stay on the default voice). */
  voiceCategoryId: string | null;
  /** Display name of the unlocked voice category (e.g. "Basic"/"Premium"), resolved
   *  by the public /billing/plans endpoint so the subscribe page can show a voice pill. */
  voiceCategoryName?: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  active: boolean;
  sortOrder: number;
  recommended: boolean;
  /** Pre-selected plan on the onboarding subscribe page (at most one is default). */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** Admin list only: live subscribers + legacy flag (deactivated but still in use). */
  subscriberCount?: number;
  legacy?: boolean;
}

export interface SubscriptionDetail {
  status: string;
  planId: string | null;
  planName: string | null;
  priceCents: number;
  currency: string;
  interval: string;
  includedMinutes: number;
  smsEnabled: boolean;
  smsToCallerEnabled: boolean;
  whatsappEnabled: boolean;
  customCrmEnabled: boolean;
  multilingualEnabled: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  autoRenew: boolean;
  legacy: boolean;
  scheduledPlan: { id: string; name: string; effectiveAt: string | null } | null;
  /** The coupon discount running on this account, or null. */
  discount: ActiveDiscount | null;
}

/** A coupon discount currently applied to the signed-in user's subscription. */
export interface ActiveDiscount {
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  cyclesUsed: number;
  durationCycles: number;
  cyclesLeft: number;
}

/** Result of checking a coupon code at checkout. Invalid results carry only a
 *  deliberately vague message — the endpoint must not confirm which codes exist. */
export type CouponValidation =
  | { valid: false; message: string }
  | {
      valid: true;
      code: string;
      displayName: string;
      description: string;
      percentOff: number | null;
      bonusMinutes: number | null;
      durationCycles: number;
      discountCents: number;
      newTotalCents: number;
      currency: string;
    };

/** Admin view of a coupon, with its live redemption counts. */
export interface Coupon {
  id: string;
  code: string;
  displayName: string;
  description: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  durationCycles: number;
  startsAt: string | null;
  expiresAt: string | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  newCustomersOnly: boolean;
  planIds: string[];
  active: boolean;
  stripeCouponId: string | null;
  createdAt: string;
  activeRedemptions: number;
  totalRedemptions: number;
  /** Checkouts holding a live reservation right now. */
  livePending: number;
  /** Terms frozen — someone has redeemed it, or is checking out with it. */
  locked: boolean;
  soldOut: boolean;
}

export interface CouponInput {
  code: string;
  displayName: string;
  description?: string;
  percentOff?: number | null;
  bonusMinutes?: number | null;
  durationCycles?: number;
  startsAt?: string | null;
  expiresAt?: string | null;
  maxRedemptions?: number | null;
  newCustomersOnly?: boolean;
  planIds?: string[];
  active?: boolean;
}

/** One row in the admin's "grant a coupon" picker, with eligibility resolved
 *  server-side so the button and the rule can't disagree. */
export interface GrantableCoupon {
  id: string;
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  durationCycles: number;
  eligible: boolean;
  /** Why it can't be granted (present only when `eligible` is false). */
  reason: string | null;
  /** Grantable, but the admin should know something first. */
  warning: string | null;
  /** Breaks a rule an admin may step past (expired / not started / wrong plan)
   *  — the grant needs an explicit override. */
  requiresOverride: boolean;
  restrictions: ("expired" | "not_started" | "plan_not_eligible")[];
  /** The window date being stepped past (ISO), for the confirmation copy. */
  windowEndsAt: string | null;
}

/** What the customer's Discount card renders. */
export interface CustomerDiscount {
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  cyclesUsed: number;
  durationCycles: number;
  cyclesLeft: number;
  grantedByAdmin: boolean;
  appliedAt: string | null;
}

export interface CustomerCouponState {
  discount: CustomerDiscount | null;
  coupons: GrantableCoupon[];
}

export interface CouponRedemptionRow {
  id: string;
  status: "pending" | "active" | "exhausted" | "revoked";
  cyclesUsed: number;
  reservedAt: string;
  appliedAt: string | null;
  endedAt: string | null;
  grantedBy: string | null;
  user: { id: string; email: string; fullName: string };
}

export interface PlanChangePreview {
  direction: "upgrade" | "downgrade" | "same";
  isTrial: boolean;
  currentPlan: { id: string; name: string; priceCents: number };
  newPlan: { id: string; name: string; priceCents: number; includedMinutes: number };
  minutesAllocated: number;
  minutesRemaining: number;
  creditCents: number;
  amountDueCents: number;
  currency: string;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  /** Name of a pending downgrade this change would replace/cancel, if any. */
  replacesScheduledPlanName: string | null;
  effectiveAt: string | null;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

export interface PlanInput {
  name: string;
  displayName: string;
  description?: string;
  priceCents: number;
  currency?: string;
  interval?: BillingInterval;
  includedMinutes?: number;
  smsEnabled?: boolean;
  smsToCallerEnabled?: boolean;
  whatsappEnabled?: boolean;
  customCrmEnabled?: boolean;
  multilingualEnabled?: boolean;
  transcriptsEnabled?: boolean;
  allowedVoices?: string[];
  voiceCategoryId?: string | null;
  sortOrder?: number;
  recommended?: boolean;
  isDefault?: boolean;
  features?: string[];
  active?: boolean;
}

export interface IntegrationField {
  key: string;
  label: string;
  secret: boolean;
  isSet: boolean;
  value: string; // masked for secrets, full for non-secrets
}

export interface IntegrationView {
  id: string;
  name: string;
  description: string;
  /** Admin saved the required keys in the DB. */
  connected: boolean;
  fields: IntegrationField[];
}

/** One selectable LLM in the admin "Default Agent Model" dropdown. */
export interface AgentLlmOption {
  provider: string;
  model: string;
  label: string;
  providerLabel: string;
  /** Vapi's estimated cost/min (USD) & latency (ms) — null when Vapi has no estimate. */
  costPerMin: number | null;
  latencyMs: number | null;
}

/** Response of the admin default-agent-LLM endpoint: the current selection plus
 *  the catalogue to choose from and the built-in default. */
export interface AgentLlmSettings {
  provider: string;
  model: string;
  options: AgentLlmOption[];
  default: { provider: string; model: string };
}

/** One selectable transcriber provider in the admin fallback dropdown. */
export interface TranscriberOption {
  provider: string;
  label: string;
  models: string[];
  /** Tiers the provider can transcribe ("en" | "multi" | "wide"). */
  tiers: string[];
}

/** Response of the admin transcriber-fallback endpoint: the saved preference plus
 *  the provider/model catalogue to choose from. */
export interface TranscriberFallbackSettings {
  autoFallback: boolean;
  provider: string;
  model: string;
  options: TranscriberOption[];
}

export type BrandingSlot =
  | "logoLight"
  | "logoDark"
  | "favicon"
  | "avatarFemale"
  | "avatarMale";
export type Branding = Record<BrandingSlot, string>;
export interface BrandingState {
  storageConfigured: boolean;
  assets: Branding;
}

export interface AdminOverview {
  /** Real end-users (role USER) — never counts admins/staff/resellers. */
  customers: number;
  /** Customers who signed up in the last 30 days. */
  newCustomers: number;
  /** Customers currently in a free trial (not yet billed). */
  trialing: number;
  /** Truly paying subscribers (subscriptionStatus active | past_due). */
  paying: number;
  /** Real monthly recurring revenue, derived from each paying plan's price. */
  mrr: number;
  totalCalls: number;
  /** Real metered minutes consumed (free-trial + paid-plan), not call-log durations. */
  totalMinutes: number;
  trialMinutes: number;
  planMinutes: number;
  phones: { total: number; assigned: number; available: number };
  resellers: number;
  /** Unpaid reseller commission owed, in whole currency units. */
  pendingCommission: number;
  staff: number;
  admins: number;
  /** Distribution of live customers across their actual plans (legacy flagged). */
  planMix: { id: string | null; name: string; subscribers: number; legacy: boolean }[];
  recentSignups: {
    id: string;
    email: string;
    fullName: string;
    plan: "free" | "premium";
    planName: string | null;
    status: string;
    createdAt: string;
  }[];
}

export interface Customer {
  id: string;
  email: string;
  fullName: string;
  role: "USER" | "ADMIN" | "STAFF" | "RESELLER";
  businessName: string;
  plan: "free" | "premium";
  numberActivated: boolean;
  /** Real subscription state (source of truth for plan name + status). */
  subscriptionStatus: string; // none | trialing | active | past_due | canceled | suspended
  /** Derived: verified account that never FINISHED onboarding (no plan, no
   *  card-less trial yet). Not a stored status — computed from lifecycle state. */
  onboarding: boolean;
  /** Derived: completed onboarding, no paid plan, still inside the card-less free
   *  trial (subscriptionStatus stays "none" for them). Drives the Trial badge. */
  freeTrial: boolean;
  /** True only for an admin account lock (vs a grace-lapsed billing suspension). */
  suspended: boolean;
  planName: string | null;
  planPriceCents: number;
  planInterval: string;
  /** Live Vapi assistant id (links to the Vapi dashboard), null if not provisioned. */
  vapiAssistantId: string | null;
  callCount: number;
  createdAt: string;
  /** When the customer opted out of notification emails (null = still subscribed). */
  emailOptOutAt: string | null;
  /** Live presence — the customer has the app open right now (active SSE stream).
   *  Point-in-time only: it resets on an API restart and says nothing about when
   *  they were last seen. */
  online: boolean;
}

/* ---------------------- Admin → Subscriptions ---------------------- */

/** A customer's plan as shown in Admin → Subscriptions (legacy = deactivated). */
export interface AdminSubscriptionPlanRef {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  interval: string;
  legacy: boolean;
}

/** Pending scheduled downgrade — the plan they'll move to at period end. */
export interface AdminScheduledPlan {
  id: string;
  name: string;
  effectiveAt: string | null;
}

export interface AdminSubscriptionRow {
  userId: string;
  fullName: string;
  email: string;
  /** Contact mobile from the profile ("" when not captured). */
  phone: string;
  businessName: string;
  /** Account creation date — when this lead registered. */
  signupAt: string;
  /** Registered but never subscribed — onboarding drop-off / no plan picked. */
  underOnboarding: boolean;
  /** Pending funnel step (5=Services, 6=Voice, 7=Finish, 8=Pricing); 0 = done or direct signup. */
  onboardingStep: number;
  onboardingCompletedAt: string | null;
  plan: AdminSubscriptionPlanRef | null;
  /** none | trialing | active | past_due | canceled | suspended (admin lock wins). */
  status: string;
  autoRenew: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  scheduledPlan: AdminScheduledPlan | null;
  /** Current-phase usage: trial counters while trialing, plan counters otherwise. */
  minutesUsed: number;
  minutesAllocated: number;
  /** This row's monthly-normalised MRR contribution (0 unless active/past_due). */
  mrrCents: number;
}

export interface AdminSubscriptionsSummary {
  total: number;
  active: number;
  trialing: number;
  pastDue: number;
  /** Registered but never subscribed — the "Under onboarding" call list. */
  onboarding: number;
  /** Canceled + suspended — had a subscription and lost it (excludes onboarding leads). */
  canceled: number;
  mrrCents: number;
}

export interface AdminSubscriptionsResponse {
  summary: AdminSubscriptionsSummary;
  subscriptions: AdminSubscriptionRow[];
}

export type PlanEventType =
  | "trial_started"
  | "trial_converted"
  | "upgraded"
  | "downgrade_scheduled"
  | "downgraded"
  | "downgrade_canceled"
  | "plan_switched"
  | "renewed"
  | "canceled"
  | "auto_renew_off"
  | "auto_renew_on"
  | "coupon_applied"
  | "coupon_expired"
  | "coupon_reattached";

/** One plan-history timeline entry (plan names denormalized at write time). */
export interface PlanEvent {
  id: string;
  type: PlanEventType;
  fromPlanId: string | null;
  fromPlanName: string | null;
  toPlanId: string | null;
  toPlanName: string | null;
  priceCents: number;
  currency: string;
  /** Money actually charged for this event (0 for free transitions). */
  amountCents: number;
  note: string;
  createdAt: string;
}

export interface AdminSubscriptionDetail {
  customer: {
    id: string;
    fullName: string;
    email: string;
    phone: string;
    businessName: string;
    createdAt: string;
  };
  subscription: {
    status: string;
    underOnboarding: boolean;
    onboardingStep: number;
    plan: AdminSubscriptionPlanRef | null;
    autoRenew: boolean;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    scheduledPlan: AdminScheduledPlan | null;
    stripeCustomerId: string | null;
    minutesUsed: number;
    minutesAllocated: number;
  };
  history: PlanEvent[];
  invoices: Invoice[];
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string;
  createdAt: string;
}

export interface AuditLogPage {
  rows: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  actions: string[];
}

export type WebhookDeliveryStatus = "all" | "success" | "failed";

export interface WebhookDeliveryLog {
  id: string;
  provider: string;
  url: string;
  status: number;
  success: boolean;
  responseBody: string;
  errorMessage: string;
  durationMs: number;
  callLogId: string | null;
  createdAt: string;
}

export interface SystemHealth {
  integrations: Record<string, boolean>;
  webhooks: {
    total: number;
    success: number;
    failed: number;
    successRate: number;
    avgLatencyMs: number;
    last24h: number;
  };
  counts: {
    totalUsers: number;
    totalCalls: number;
    callsLast24h: number;
    pendingApprovals: number;
  };
  recentErrors: {
    provider: string;
    errorMessage: string;
    status: number;
    createdAt: string;
  }[];
}

export interface CustomerDetail {
  customer: {
    id: string;
    email: string;
    fullName: string;
    role: "USER" | "ADMIN" | "STAFF" | "RESELLER";
    businessName: string;
    plan: "free" | "premium";
    numberActivated: boolean;
    mobile: string;
    website: string;
    subscriptionStatus: string;
    trialEndsAt: string | null;
    receptionistNumber: string;
    createdAt: string;
  };
  agent: {
    name: string;
    status: string;
    vapiAssistantId: string | null;
    agentConfig: AgentConfig;
  } | null;
  calls: {
    id: string;
    /** "Web" = a browser test call, "Phone" = a real inbound call. */
    type: "Web" | "Phone";
    callerName: string;
    callerNumber: string;
    outcome: string;
    durationSec: number;
    createdAt: string;
  }[];
  usage: { callsHandled: number; minutesUsed: number };
  billing: {
    plan: "free" | "premium";
    /** The subscribed plan's display name ("Standard"), or null when there's no
     *  plan. Preferred over `plan`, which reads "free" during a paid-plan trial. */
    planName: string | null;
    subscriptionStatus: string;
    /** Derived: verified account that never FINISHED onboarding. */
    onboarding: boolean;
    /** Derived: completed onboarding, no plan, still on the card-less free trial. */
    freeTrial: boolean;
    /** True only for an admin account lock (vs a grace-lapsed billing suspension). */
    suspended: boolean;
    stripeCustomerId: string | null;
    trialEndsAt: string | null;
    /** Which onboarding rule applied the day THIS account was created — the admin
     *  toggle never affects existing accounts, so this is the only way to explain
     *  why two customers behave differently. */
    cardRequiredAtSignup: boolean;
    /** When their first card landed; null = never. With the flag above, identifies
     *  a customer still stuck at the card wall. */
    cardConfirmedAt: string | null;
  };
}

export interface UserDigest {
  subject: string;
  html: string;
  stats: {
    callsHandled: number;
    leadsCaptured: number;
    minutesUsed: number;
    missed: number;
    topIntents: { intent: string; count: number }[];
  };
}
