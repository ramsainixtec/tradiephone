import { lazy, Suspense, useEffect } from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
} from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { RequireAdmin } from "@/components/auth/RequireAdmin";
import { RequireCustomer } from "@/components/auth/RequireCustomer";
import { RedirectIfAuthed } from "@/components/auth/RedirectIfAuthed";
import { Loader2 } from "lucide-react";
import { captureReferralFromUrl } from "@/lib/referral";
import { clearChunkReloadGuard, clearBootReloadGuard } from "@/lib/chunkReload";
import { RouteError } from "@/components/RouteError";
import { ScrollToTop } from "@/components/ScrollToTop";
import { SeoManager } from "@/components/SeoManager";
import { useBrandingStore } from "@/stores/useBrandingStore";

const LandingPage = lazy(() => import("@/pages/marketing/LandingPage"));
const OnboardingPage = lazy(() => import("@/pages/onboarding/OnboardingPage"));
const LoginPage = lazy(() => import("@/pages/auth/LoginPage"));
const SubscribePage = lazy(() => import("@/pages/subscribe/SubscribePage"));
const ResellerPortalPage = lazy(() => import("@/pages/reseller/ResellerPortalPage"));
const DashboardPage = lazy(() => import("@/pages/dashboard/DashboardPage"));
const CallInboxPage = lazy(() => import("@/pages/calls/CallInboxPage"));
const AiBrainPage = lazy(() => import("@/pages/assistant/AiBrainPage"));
const ConnectCrmPage = lazy(() => import("@/pages/crm/ConnectCrmPage"));
const SettingsPage = lazy(() => import("@/pages/settings/SettingsPage"));
const PlansPage = lazy(() => import("@/pages/billing/PlansPage"));
const CallForwardingPage = lazy(() => import("@/pages/forwarding/CallForwardingPage"));
const HumanTransferPage = lazy(() => import("@/pages/transfer/HumanTransferPage"));
const BookingPage = lazy(() => import("@/pages/booking/BookingPage"));
const SmsToCallerPage = lazy(() => import("@/pages/smsToCaller/SmsToCallerPage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));
const StaffNoAccessPage = lazy(() => import("@/pages/StaffNoAccessPage"));

const AdminOverviewPage = lazy(() => import("@/pages/admin/AdminOverviewPage"));
const AdminCustomersPage = lazy(() => import("@/pages/admin/AdminCustomersPage"));
const AdminSubscriptionsPage = lazy(() => import("@/pages/admin/AdminSubscriptionsPage"));
const AdminPlansPage = lazy(() => import("@/pages/admin/AdminPlansPage"));
const AdminCouponsPage = lazy(() => import("@/pages/admin/AdminCouponsPage"));
const AdminResellersPage = lazy(() => import("@/pages/admin/AdminResellersPage"));
const AdminSettingsPage = lazy(() => import("@/pages/admin/AdminSettingsPage"));
const AdminVoiceBankPage = lazy(() => import("@/pages/admin/AdminVoiceBankPage"));
const AdminAuditLogPage = lazy(() => import("@/pages/admin/AdminAuditLogPage"));
const AdminWebhookLogsPage = lazy(() => import("@/pages/admin/AdminWebhookLogsPage"));
const AdminSystemHealthPage = lazy(() => import("@/pages/admin/AdminSystemHealthPage"));
const AdminSystemEmailsPage = lazy(() => import("@/pages/admin/AdminSystemEmailsPage"));
const AdminCustomerDetailPage = lazy(() => import("@/pages/admin/AdminCustomerDetailPage"));
const AdminReportsPage = lazy(() => import("@/pages/admin/AdminReportsPage"));
const AdminPhoneNumbersPage = lazy(() => import("@/pages/admin/phone-numbers/AdminPhoneNumbersPage"));
const AdminStaffPage = lazy(() => import("@/pages/admin/AdminStaffPage"));
const AdminStaffDetailPage = lazy(() => import("@/pages/admin/AdminStaffDetailPage"));
const AdminRolesPage = lazy(() => import("@/pages/admin/AdminRolesPage"));
const AdminRoleDetailPage = lazy(() => import("@/pages/admin/AdminRoleDetailPage"));

// API Center. Each section is its own chunk so opening the admin area doesn't
// pull every screen's charts and tables the operator may never visit.
const ApiCenterLayout = lazy(() => import("@/pages/admin/api-center/ApiCenterLayout"));
const ApiCenterOverviewPage = lazy(() => import("@/pages/admin/api-center/OverviewPage"));
const ApiCenterProvidersPage = lazy(() => import("@/pages/admin/api-center/ProvidersPage"));
const ApiCenterActivityPage = lazy(() => import("@/pages/admin/api-center/ActivityPage"));
const ApiCenterCostsPage = lazy(() => import("@/pages/admin/api-center/CostsPage"));
const ApiCenterSettingsPage = lazy(() => import("@/pages/admin/api-center/SettingsPage"));

function PageFallback() {
  return (
    <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" />
    </div>
  );
}

// Single Suspense boundary for the lazily-loaded route components. Using a data
// router (createBrowserRouter) instead of <BrowserRouter> so pages can guard
// navigation with useBlocker (e.g. the AI Brain unsaved-changes prompt).
function RootLayout() {
  return (
    <>
      <ScrollToTop />
      <SeoManager />
      <Suspense fallback={<PageFallback />}>
        <Outlet />
      </Suspense>
    </>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />} errorElement={<RouteError />}>
      <Route path="/" element={<RedirectIfAuthed><LandingPage /></RedirectIfAuthed>} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/subscribe" element={<RequireAuth><SubscribePage /></RequireAuth>} />
      <Route path="/reseller" element={<RequireAuth><ResellerPortalPage /></RequireAuth>} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        {/* Customer-facing — STAFF (no customer profile) are redirected to their
            admin landing so these never hang on a perpetual loading skeleton. */}
        <Route path="/dashboard" element={<RequireCustomer><DashboardPage /></RequireCustomer>} />
        <Route path="/dashboard/calls" element={<RequireCustomer><CallInboxPage /></RequireCustomer>} />
        <Route path="/dashboard/assistant" element={<RequireCustomer><AiBrainPage /></RequireCustomer>} />
        <Route path="/dashboard/crm" element={<RequireCustomer><ConnectCrmPage /></RequireCustomer>} />
        <Route path="/dashboard/plans" element={<RequireCustomer><PlansPage /></RequireCustomer>} />
        <Route path="/dashboard/forwarding" element={<RequireCustomer><CallForwardingPage /></RequireCustomer>} />
        <Route path="/dashboard/transfer" element={<RequireCustomer><HumanTransferPage /></RequireCustomer>} />
        <Route path="/dashboard/booking" element={<RequireCustomer><BookingPage /></RequireCustomer>} />
        <Route path="/dashboard/sms-to-caller" element={<RequireCustomer><SmsToCallerPage /></RequireCustomer>} />
        <Route path="/dashboard/settings" element={<SettingsPage />} />

        {/* Staff with no permitted section land here (see StaffNoAccessPage). */}
        <Route
          path="/dashboard/no-access"
          element={<RequireAdmin><StaffNoAccessPage /></RequireAdmin>}
        />

        {/* Admin-only */}
        <Route
          path="/dashboard/admin/overview"
          element={<RequireAdmin><AdminOverviewPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/customers"
          element={<RequireAdmin><AdminCustomersPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/customers/:id"
          element={<RequireAdmin><AdminCustomerDetailPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/subscriptions"
          element={<RequireAdmin><AdminSubscriptionsPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/plans"
          element={<RequireAdmin><AdminPlansPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/coupons"
          element={<RequireAdmin><AdminCouponsPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/voice-bank"
          element={<RequireAdmin><AdminVoiceBankPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/phone-numbers"
          element={<RequireAdmin><AdminPhoneNumbersPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/resellers"
          element={<RequireAdmin><AdminResellersPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/settings"
          element={<RequireAdmin><AdminSettingsPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/emails"
          element={<RequireAdmin><AdminSystemEmailsPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/health"
          element={<RequireAdmin><AdminSystemHealthPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/webhooks"
          element={<RequireAdmin><AdminWebhookLogsPage /></RequireAdmin>}
        />
        {/* API Center — the layout owns the shared snapshot, filters and drawer;
            sections render into its outlet, so switching tabs is instant and
            every screen describes the same moment. */}
        <Route
          path="/dashboard/admin/api-center"
          element={<RequireAdmin><ApiCenterLayout /></RequireAdmin>}
        >
          <Route index element={<ApiCenterOverviewPage />} />
          <Route path="providers" element={<ApiCenterProvidersPage />} />
          <Route path="activity" element={<ApiCenterActivityPage />} />
          <Route path="costs" element={<ApiCenterCostsPage />} />
          <Route path="settings" element={<ApiCenterSettingsPage />} />
          {/* The twelve-section layout that shipped first folded into five. Old
              links (and anyone's bookmarks) land on the section that absorbed
              them rather than a 404. Absolute targets on purpose: a relative
              `to` resolves against the redirecting route's own path, which would
              send /…/connections to /…/connections/providers. */}
          <Route path="connections" element={<Navigate to="/dashboard/admin/api-center/providers" replace />} />
          <Route path="health" element={<Navigate to="/dashboard/admin/api-center/providers" replace />} />
          <Route path="quotas" element={<Navigate to="/dashboard/admin/api-center/providers" replace />} />
          <Route path="keys" element={<Navigate to="/dashboard/admin/api-center/providers" replace />} />
          <Route path="usage" element={<Navigate to="/dashboard/admin/api-center/activity" replace />} />
          <Route path="latency" element={<Navigate to="/dashboard/admin/api-center/activity" replace />} />
          <Route path="errors" element={<Navigate to="/dashboard/admin/api-center/activity" replace />} />
          <Route path="logs" element={<Navigate to="/dashboard/admin/api-center/activity" replace />} />
          <Route path="alerts" element={<Navigate to="/dashboard/admin/api-center/settings" replace />} />
        </Route>
        <Route
          path="/dashboard/admin/reports"
          element={<RequireAdmin><AdminReportsPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/audit"
          element={<RequireAdmin><AdminAuditLogPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/staff"
          element={<RequireAdmin><AdminStaffPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/staff/new"
          element={<RequireAdmin><AdminStaffDetailPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/staff/:id"
          element={<RequireAdmin><AdminStaffDetailPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/roles"
          element={<RequireAdmin><AdminRolesPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/roles/new"
          element={<RequireAdmin><AdminRoleDetailPage /></RequireAdmin>}
        />
        <Route
          path="/dashboard/admin/roles/:id"
          element={<RequireAdmin><AdminRoleDetailPage /></RequireAdmin>}
        />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Route>,
  ),
);

export function App() {
  useEffect(() => {
    captureReferralFromUrl();
    void useBrandingStore.getState().refresh();
    // App mounted cleanly → reset the one-reload budgets so a future deploy's
    // stale-chunk or failed boot can self-heal again.
    clearChunkReloadGuard();
    clearBootReloadGuard();
  }, []);
  return <RouterProvider router={router} />;
}
