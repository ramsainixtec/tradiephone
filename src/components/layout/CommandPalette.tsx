import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  BrainCircuit,
  Plug,
  CreditCard,
  LayoutGrid,
  Users,
  Package,
  Phone,
  Handshake,
  ScrollText,
  Settings,
  UserCog,
  Search,
  CornerDownLeft,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useAuthStore } from "@/stores/useAuthStore";

interface Destination {
  to: string;
  label: string;
  group: string;
  icon: LucideIcon;
  /** Extra search terms — lets a query match content *inside* a page, not just its title. */
  keywords?: string[];
  /** Shown under the label when it matched (so the user sees why). */
  hint?: string;
  permission?: string;
  adminOnly?: boolean;
  adminOrStaff?: boolean;
}

// Mirrors the sidebar routes so the palette jumps to the same real pages. The
// `keywords` make in-page content discoverable — e.g. "whatsapp" or "smtp"
// resolves to Platform Settings even though that word isn't in the title.
const DESTINATIONS: Destination[] = [
  { to: "/dashboard", label: "Dashboard", group: "Workspace", icon: LayoutDashboard, keywords: ["home", "analytics", "overview", "calls", "leads", "stats", "metrics"] },
  { to: "/dashboard/calls", label: "Call Inbox", group: "Workspace", icon: Inbox, keywords: ["calls", "recordings", "transcripts", "voicemail", "missed", "history", "messages"] },
  { to: "/dashboard/assistant", label: "AI Brain", group: "Workspace", icon: BrainCircuit, keywords: ["assistant", "agent", "knowledge", "prompt", "persona", "identity", "rules", "automations", "training", "faqs", "voice"] },
  { to: "/dashboard/crm", label: "Connect CRM", group: "Workspace", icon: Plug, keywords: ["integration", "hubspot", "salesforce", "zapier", "leads", "contacts", "sync"] },
  { to: "/dashboard/plans", label: "Plans & Billing", group: "Workspace", icon: CreditCard, keywords: ["billing", "subscription", "upgrade", "invoice", "payment", "pricing", "renew"] },
  { to: "/dashboard/settings", label: "Account Settings", group: "Workspace", icon: Settings, keywords: ["profile", "account", "password", "email", "business name", "mobile", "website", "personal"] },
  { to: "/dashboard/admin/overview", label: "Overview", group: "Admin", icon: LayoutGrid, permission: "overview", adminOrStaff: true, keywords: ["admin", "metrics", "revenue", "signups", "stats"] },
  { to: "/dashboard/admin/customers", label: "Customers", group: "Admin", icon: Users, permission: "customers", adminOrStaff: true, keywords: ["users", "accounts", "clients", "members"] },
  { to: "/dashboard/admin/subscriptions", label: "Subscriptions", group: "Admin", icon: CreditCard, permission: "subscriptions", adminOrStaff: true, keywords: ["billing", "mrr", "revenue", "payments", "invoices", "trial", "active", "past due", "canceled", "onboarding", "under onboarding", "leads", "plan history", "renewals", "win-back"] },
  { to: "/dashboard/admin/plans", label: "Plans", group: "Admin", icon: Package, permission: "plans", adminOrStaff: true, keywords: ["pricing", "tiers", "packages", "products"] },
  { to: "/dashboard/admin/phone-numbers", label: "Phone Numbers", group: "Admin", icon: Phone, permission: "phone_numbers", adminOrStaff: true, keywords: ["numbers", "did", "twilio", "caller id", "provisioning"] },
  { to: "/dashboard/admin/resellers", label: "Resellers", group: "Admin", icon: Handshake, permission: "resellers", adminOrStaff: true, keywords: ["partners", "commission", "affiliates", "agency"] },
  { to: "/dashboard/admin/audit", label: "Audit Log", group: "Admin", icon: ScrollText, permission: "audit", adminOrStaff: true, keywords: ["logs", "activity", "history", "events", "security"] },
  {
    to: "/dashboard/admin/settings",
    label: "Platform Settings",
    group: "Admin",
    icon: Settings,
    permission: "settings",
    adminOrStaff: true,
    keywords: [
      "integrations", "api keys", "api key", "secrets", "keys",
      "whatsapp", "meta", "webhook", "verify token", "app secret", "phone number id",
      "vapi", "voice calling", "voice ai",
      "deepgram", "text to speech", "tts",
      "openai", "llm", "gpt", "model",
      "stripe", "billing", "webhook secret",
      "email", "smtp", "sendgrid", "mail", "from address",
      "google calendar", "oauth", "client id", "client secret", "redirect uri",
      "twilio", "perfex",
      "branding", "logo", "favicon", "dark mode logo", "light mode logo", "theme",
    ],
  },
  { to: "/dashboard/admin/staff", label: "Staff", group: "Admin", icon: UserCog, adminOnly: true, keywords: ["team", "permissions", "roles", "members", "access"] },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  useBodyScrollLock(open);
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isAdmin = user?.role === "ADMIN";
  const isStaff = user?.role === "STAFF";
  const isAdminOrStaff = isAdmin || isStaff;

  const email = user?.email?.toLowerCase();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = DESTINATIONS.filter((d) => {
      if (d.adminOnly && !isAdmin) return false;
      if (d.adminOrStaff && !isAdminOrStaff) return false;
      if (d.permission && isStaff && !hasPermission(d.permission)) return false;
      return true;
    });
    if (!q) return visible.map((d) => ({ d, hint: undefined as string | undefined }));

    return visible
      .map((d) => {
        if (d.label.toLowerCase().includes(q) || d.group.toLowerCase().includes(q)) {
          return { d, hint: undefined as string | undefined };
        }
        // Account Settings also matches the signed-in user's own email.
        if (d.to === "/dashboard/settings" && email?.includes(q)) {
          return { d, hint: email };
        }
        const kw = d.keywords?.find((k) => k.includes(q));
        if (kw) return { d, hint: kw };
        return null;
      })
      .filter((r): r is { d: Destination; hint: string | undefined } => r !== null);
  }, [query, email, isAdmin, isStaff, isAdminOrStaff, hasPermission]);

  // Reset state each time the palette opens, and focus the field.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  function go(to: string) {
    navigate(to);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) go(hit.d.to);
    }
  }

  // Keep the active row scrolled into view.
  const setRowRef = (i: number) => (el: HTMLButtonElement | null) => {
    if (el && i === active) el.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      {/* panel */}
      <div
        className="animate-in relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]"
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, jump to…"
            className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              No matches for “{query}”
            </p>
          ) : (
            results.map(({ d, hint }, i) => {
              const Icon = d.icon;
              const isActive = i === active;
              return (
                <button
                  key={d.to}
                  ref={setRowRef(i)}
                  type="button"
                  onClick={() => go(d.to)}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                    isActive ? "bg-primary-tint text-primary" : "text-foreground hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-lg",
                      isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{d.label}</span>
                    {hint && (
                      <span className="truncate text-[11px] font-normal capitalize text-muted-foreground">
                        matches “{hint}”
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{d.group}</span>
                  {isActive && <CornerDownLeft className="size-4 shrink-0 text-primary" />}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border bg-warm/60 px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-card px-1">↑</kbd>
            <kbd className="rounded border border-border bg-card px-1">↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-card px-1">↵</kbd> open
          </span>
        </div>
      </div>
    </div>
  );
}
