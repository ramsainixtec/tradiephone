import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  BrainCircuit,
  Plug,
  Settings,
  PhoneCall,
  Phone,
  PhoneForwarded,
  PhoneOutgoing,
  CalendarCheck,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  LayoutGrid,
  Users,
  UserCog,
  CreditCard,
  Package,
  Ticket,
  ShieldCheck,
  Handshake,
  Activity,
  Webhook,
  FileBarChart,
  ScrollText,
  Mic,
  Mail,
  X,
  LogOut,
  Sun,
  Moon,
  Monitor,
  BellRing,
  ArrowRight,
  Crown,
  Radar,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn, titleCaseName } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/misc";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { FREE_PLAN_MINUTES, useProfileStore } from "@/stores/useProfileStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { blockedCopy } from "@/lib/trial";
import { cachedSmsToCallerEntitlement } from "@/lib/planFeatures";
import { TrialMinutesMeter } from "@/components/trial/TrialIndicators";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ⌘B on macOS, Ctrl+B elsewhere — matches the global sidebar-toggle handler.
const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const SIDEBAR_SHORTCUT = isMac ? "⌘B" : "Ctrl+B";

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;
const THEME_CYCLE = ["light", "dark", "system"] as const;
const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  STAFF: "Staff",
  USER: "Member",
  RESELLER: "Reseller",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  tourKey?: string;
  /** Show a Crown when the plan doesn't include this module. The item stays
   *  visible on purpose — same call the plan cards make, where excluded
   *  features are struck through rather than hidden, so people can still
   *  discover what an upgrade buys. */
  premiumWhenLocked?: boolean;
  /** Temporarily hidden from the UI via CSS (kept routable). */
  hidden?: boolean;
  /** Permission key required to see this item (STAFF only — ADMINs see all). */
  permission?: string;
  /** Only full ADMINs see this item (not STAFF). */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true, tourKey: "dashboard" },
  { to: "/dashboard/calls", label: "Call Inbox", icon: Inbox, tourKey: "calls" },
  { to: "/dashboard/assistant", label: "AI Brain", icon: BrainCircuit, tourKey: "assistant" },
  { to: "/dashboard/crm", label: "Connect CRM", icon: Plug, tourKey: "crm" },
  { to: "/dashboard/plans", label: "Plans & Billing", icon: CreditCard, tourKey: "plans" },
  { to: "/dashboard/forwarding", label: "Call Forwarding", icon: PhoneForwarded, tourKey: "forwarding" },
  { to: "/dashboard/transfer", label: "Call Transfer", icon: PhoneOutgoing, tourKey: "transfer" },
  { to: "/dashboard/booking", label: "Booking", icon: CalendarCheck, tourKey: "booking" },
  { to: "/dashboard/sms-to-caller", label: "SMS to Caller", icon: MessageSquareText, tourKey: "smsToCaller", premiumWhenLocked: true },
];

// Routes already reachable from the mobile bottom app bar (see BottomNav.tsx).
// The mobile sidebar drawer hides these to avoid duplicating them.
const BOTTOM_NAV_ROUTES = new Set([
  "/dashboard",
  "/dashboard/calls",
  "/dashboard/assistant",
  "/dashboard/crm",
]);

const ADMIN_NAV: NavItem[] = [
  { to: "/dashboard/admin/overview", label: "Overview", icon: LayoutGrid, permission: "overview" },
  { to: "/dashboard/admin/customers", label: "Customers", icon: Users, permission: "customers" },
  { to: "/dashboard/admin/subscriptions", label: "Subscriptions", icon: CreditCard, permission: "subscriptions" },
  { to: "/dashboard/admin/plans", label: "Plans", icon: Package, permission: "plans" },
  { to: "/dashboard/admin/coupons", label: "Coupons", icon: Ticket, permission: "coupons" },
  { to: "/dashboard/admin/voice-bank", label: "Voice Library", icon: Mic, permission: "voice_bank" },
  { to: "/dashboard/admin/phone-numbers", label: "Phone Numbers", icon: Phone, permission: "phone_numbers" },
  { to: "/dashboard/admin/resellers", label: "Resellers", icon: Handshake, permission: "resellers" },
  // API Center — one entry. Its sections are tabs on the page itself, so
  // repeating them here would be a second copy of the same navigation and make
  // the admin list twice as long for no extra reach.
  { to: "/dashboard/admin/api-center", label: "API Center", icon: Radar, adminOnly: true },
  // Reports, Webhook Logs, System Health and Settings are ADMIN-only areas —
  // not staff-assignable (removed from the role permission matrix).
  { to: "/dashboard/admin/health", label: "System Health", icon: Activity, hidden: true, adminOnly: true },
  { to: "/dashboard/admin/webhooks", label: "Webhook Logs", icon: Webhook, hidden: true, adminOnly: true },
  { to: "/dashboard/admin/reports", label: "Reports", icon: FileBarChart, hidden: true, adminOnly: true },
  { to: "/dashboard/admin/audit", label: "Audit Log", icon: ScrollText, permission: "audit" },
  { to: "/dashboard/admin/roles", label: "Roles", icon: ShieldCheck, adminOnly: true },
  { to: "/dashboard/admin/staff", label: "Staff", icon: UserCog, adminOnly: true },
  { to: "/dashboard/admin/emails", label: "System Emails", icon: Mail, permission: "emails" },
  { to: "/dashboard/admin/settings", label: "Settings", icon: Settings, adminOnly: true },
];

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setTester = useUiStore((s) => s.setAssistantTester);
  const mobileSidebarOpen = useUiStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const profile = useProfileStore((s) => s.profile);
  const trial = useTrialStore((s) => s.trial);
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const isStaff = user?.role === "STAFF";
  const isAdminOrStaff = isAdmin || isStaff;
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  // Freeze the page behind the mobile drawer while it's open.
  useBodyScrollLock(mobileSidebarOpen);
  // Header over the admin nav group: full ADMINs see "Admin"; a STAFF member
  // sees their assigned role name (e.g. "Manager"), falling back to "Staff".
  const adminSectionLabel = isAdmin ? "Admin" : user?.staffRoleName || "Staff";
  // Read-only: whichever screen last fetched entitlements cached them. The badge
  // is decoration, so a stale read costs nothing — the page itself re-checks.
  const smsToCallerIncluded = cachedSmsToCallerEntitlement();

  const displayName = user?.fullName || user?.email || "User";
  const roleLabel = isStaff ? user?.staffRoleName || "Staff" : ROLE_LABEL[user?.role ?? "USER"];
  const ThemeIcon = THEME_ICONS[themeMode];
  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(themeMode);
    setThemeMode(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  };
  const handleLogout = () => {
    setMobileSidebarOpen(false);
    logout();
    navigate("/login");
  };

  const navItemClass = (collapsed: boolean) => ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
      isActive
        ? "bg-primary-tint text-primary"
        : "text-foreground/70 hover:bg-muted hover:text-foreground",
      collapsed && "justify-center px-0",
    );

  const minutesUsed = profile.webTestMinutesUsed;
  const hasEntitlement = trial?.phase === "trial" || trial?.phase === "active";

  const sidebarContent = (isMobile: boolean) => {
    const isCollapsed = isMobile ? false : collapsed;
    return (
      <>
        {/* Logo + collapse toggle */}
        <div className={cn("flex h-16 shrink-0 items-center px-4", isCollapsed ? "justify-center" : "justify-between")}>
          {!isCollapsed && (
            <NavLink
              to="/dashboard"
              end
              onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
              className="flex items-center gap-2 overflow-hidden rounded-lg"
              aria-label="Go to dashboard"
            >
              <BrandLogo imgClassName="h-10 w-auto max-w-[170px] object-contain">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <PhoneCall className="size-5" />
                </div>
                <span className="truncate text-[15px] font-semibold leading-tight">
                  hello22<span className="text-primary">.ai</span>
                </span>
              </BrandLogo>
            </NavLink>
          )}
          {isMobile ? (
            <button onClick={() => setMobileSidebarOpen(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close menu">
              <X className="size-4" />
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={toggleSidebar} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Toggle sidebar">
                  {isCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="flex items-center gap-1.5">
                {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                <kbd className="rounded border border-background/30 px-1 py-px text-[10px] font-medium">
                  {SIDEBAR_SHORTCUT}
                </kbd>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Profile + Appearance — pinned to the top of the mobile drawer. */}
        {isMobile && (
          <div className="border-b border-border px-4 pb-3">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {initials(titleCaseName(displayName))}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold leading-tight">
                  {titleCaseName(displayName)}
                </p>
                <p className="truncate text-xs text-muted-foreground">{roleLabel}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setMobileSidebarOpen(false);
                  navigate("/dashboard/settings");
                }}
                className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
              >
                <Settings className="size-4" /> Profile
              </button>
              <button
                type="button"
                onClick={cycleTheme}
                aria-label={`Appearance: ${THEME_LABEL[themeMode]} (tap to change)`}
                className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
              >
                <ThemeIcon className="size-4" /> {THEME_LABEL[themeMode]}
              </button>
            </div>
          </div>
        )}

        {/* Scrollable region: nav + Call Assistant flow together (top-aligned, no floating gap) */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
          <nav className="flex flex-col gap-1 px-3">
            {/* STAFF are admin-team members with no customer profile, so the
                customer modules (Dashboard, Call Inbox, AI Brain, CRM) don't
                apply to them — show nothing here; they get the Admin nav below.
                ADMIN keeps these (minus Plans & Billing); USER sees all. */}
            {(isStaff
              ? []
              : NAV.filter(
                  (item) =>
                    // Admins keep Call Forwarding + Call Transfer in their user
                    // nav (they have a real profile); only Plans & Billing is hidden.
                    !(isAdmin && item.to === "/dashboard/plans") &&
                    // On mobile these live in the bottom app bar, so drop them here.
                    !(isMobile && BOTTOM_NAV_ROUTES.has(item.to)),
                )
            ).map(({ to, label, icon: Icon, end, tourKey, premiumWhenLocked }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={navItemClass(isCollapsed)}
                title={isCollapsed ? label : undefined}
                onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
                {...(tourKey ? { "data-tour": tourKey } : {})}
              >
                <Icon className="size-[18px] shrink-0" />
                {!isCollapsed && <span>{label}</span>}
                {premiumWhenLocked && !smsToCallerIncluded && !isCollapsed && (
                  <Crown className="ml-auto size-4 shrink-0 text-premium" aria-label="Premium feature" />
                )}
              </NavLink>
            ))}
          </nav>

          {isAdminOrStaff && (() => {
            const visibleAdminItems = ADMIN_NAV.filter((item) => {
              if (item.adminOnly && !isAdmin) return false;
              if (item.permission && !hasPermission(item.permission)) return false;
              return true;
            });
            if (visibleAdminItems.length === 0) return null;
            return (
            <nav className="mt-2 flex flex-col gap-1 px-3">
              {!isCollapsed ? (
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <ShieldCheck className="size-3.5 text-primary" /> {adminSectionLabel}
                </div>
              ) : (
                <div className="mx-auto my-1 h-px w-6 bg-border" />
              )}
              {visibleAdminItems.map(({ to, label, icon: Icon, hidden }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={(state) => cn(navItemClass(isCollapsed)(state), hidden && "hidden")}
                  title={isCollapsed ? label : undefined}
                  onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
                >
                  <Icon className="size-[18px] shrink-0" />
                  {!isCollapsed && <span>{label}</span>}
                </NavLink>
              ))}
            </nav>
            );
          })()}

          <div className="mt-auto pt-3">
          {!isCollapsed &&
            (profile.receptionistNumber ? (
              <div className="mx-3 mt-3 rounded-xl border border-border bg-card p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Phone className="size-3.5 text-primary" />
                  AI Receptionist Number
                </div>
                <p className="mt-1.5 text-sm font-semibold tracking-tight tabular-nums text-foreground">
                  {profile.receptionistNumber}
                </p>
                {!isAdminOrStaff && (
                  <NavLink
                    to="/dashboard/forwarding"
                    onClick={isMobile ? () => setMobileSidebarOpen(false) : undefined}
                    className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
                  >
                    Need help forwarding calls?
                  </NavLink>
                )}
              </div>
            ) : (
              !isAdminOrStaff && (
                <button
                  type="button"
                  onClick={() => {
                    const qs = useQuickSetupStore.getState();
                    qs.openSetup(); // opens at the Plan step (step 1)
                  }}
                  className="mx-3 mt-3 block w-[calc(100%-1.5rem)] animate-card-beacon overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-[#1d4ed8] p-3.5 text-left text-white shadow-[var(--shadow-panel)] transition-transform hover:scale-[1.02] motion-reduce:animate-none"
                >
                  <div className="flex items-center gap-2">
                    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-danger shadow-lg shadow-danger/40">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger/60 motion-reduce:hidden" />
                      <BellRing className="relative size-4 text-white" />
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/90">
                      Action needed
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-bold leading-snug">Activate your AI number</p>
                  <p className="mt-0.5 text-xs leading-snug text-white/85">
                    Set it up to start taking real calls.
                  </p>
                  <span className="mt-2.5 inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-bold text-primary shadow-sm">
                    Set it up <ArrowRight className="size-3.5" />
                  </span>
                </button>
              )
            ))}

          <div className="mx-3 mt-3 space-y-3">
            {!isCollapsed && !isAdmin && hasEntitlement && (
              <div className="space-y-2">
                <TrialMinutesMeter />
                {trial?.blocked && (
                  <NavLink
                    to={trial.canRenew ? "/dashboard/plans?renew=1" : "/subscribe"}
                    className="block rounded-md bg-primary px-2.5 py-1.5 text-center text-xs font-semibold text-primary-foreground hover:opacity-90"
                  >
                    {trial.canRenew ? "Renew plan" : blockedCopy(trial)?.cta ?? "Upgrade"}
                  </NavLink>
                )}
              </div>
            )}
            {!isCollapsed && !isAdminOrStaff && trial && !hasEntitlement && (
              <div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Test minutes</span>
                  <span>
                    {minutesUsed}/{FREE_PLAN_MINUTES}
                  </span>
                </div>
                <ProgressBar className="mt-1" value={(minutesUsed / FREE_PLAN_MINUTES) * 100} />
              </div>
            )}
          </div>
          </div>
        </div>

        {/* Call Assistant — sticky footer below the scrollable nav, so it stays
            visible while the menu list scrolls. Hidden for STAFF: it tests the
            customer's own AI agent, which staff don't have. */}
        {!isStaff && (
          <div className="shrink-0 border-t border-border p-3">
            <Button
              variant="outline"
              className={cn(
                "w-full justify-center gap-2 border-primary/40 bg-primary-tint font-semibold text-primary shadow-(--shadow-soft) hover:bg-primary hover:text-primary-foreground",
                isCollapsed && "px-0",
              )}
              onClick={() => setTester(true)}
              title="Call Assistant"
            >
              <PhoneCall className="size-4" />
              {!isCollapsed && "Call Assistant"}
            </Button>
          </div>
        )}

        {/* Logout — pinned to the bottom of the mobile drawer (both roles). */}
        {isMobile && (
          <div className="shrink-0 border-t border-border p-3">
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-semibold text-danger transition-colors hover:bg-danger-tint"
            >
              <LogOut className="size-4" /> Log out
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-border bg-warm transition-[width] duration-200 nav:flex",
          collapsed ? "w-[72px]" : "w-64",
        )}
      >
        {sidebarContent(false)}
      </aside>

      {/* Mobile sidebar overlay — slides in from the right */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 nav:hidden">
          <div
            className="animate-in absolute inset-0 bg-black/50"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <aside className="animate-sheet-in absolute right-0 top-0 flex h-full w-72 max-w-[85%] flex-col border-l border-border bg-warm shadow-[var(--shadow-panel)]">
            {sidebarContent(true)}
          </aside>
        </div>
      )}
    </>
  );
}
