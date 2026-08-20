export const CAPABILITIES = ["view", "create", "edit", "delete"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
};

/**
 * A field (table column) that can be individually gated inside a section.
 * Allow-list semantics: a role sees a column only when it holds the matching
 * `${section}.field.${key}` permission. The section's identity column (e.g. the
 * customer name) is always shown and is NOT listed here.
 */
export interface FieldDef {
  key: string;
  label: string;
}

export interface SectionDef {
  key: string;
  label: string;
  capabilities: readonly Capability[];
  /** Column-level sub-permissions for the section's data table (optional). */
  fields?: readonly FieldDef[];
}

export const SECTIONS: SectionDef[] = [
  { key: "overview", label: "Overview", capabilities: ["view"] },
  { key: "customers", label: "Customers", capabilities: ["view", "create", "edit", "delete"] },
  {
    key: "subscriptions",
    label: "Subscriptions",
    capabilities: ["view", "edit"],
    fields: [
      { key: "plan", label: "Plan" },
      { key: "price", label: "Price" },
      { key: "status", label: "Status" },
      { key: "minutes", label: "Minutes" },
      { key: "renewal", label: "Renews / Ends" },
      { key: "autoRenew", label: "Auto-renew" },
      { key: "invoices", label: "Invoices & payments" },
    ],
  },
  { key: "plans", label: "Plans", capabilities: ["view", "create", "edit", "delete"] },
  { key: "coupons", label: "Coupons", capabilities: ["view", "create", "edit", "delete"] },
  { key: "voice_bank", label: "Voice Bank", capabilities: ["view", "create", "edit", "delete"] },
  { key: "phone_numbers", label: "Phone Numbers", capabilities: ["view", "create", "edit", "delete"] },
  { key: "resellers", label: "Resellers", capabilities: ["view", "create", "edit", "delete"] },
  { key: "emails", label: "System Emails", capabilities: ["view", "edit"] },
  { key: "audit", label: "Audit Log", capabilities: ["view"] },
  // Staff, Roles, Reports, Webhook Logs, System Health and Settings are ADMIN-only
  // areas and are intentionally NOT staff-assignable — they're excluded from the
  // role permission matrix. Every one of their pages/routes is gated by
  // `requireAdmin` (never `requirePermission`), so a STAFF member could never use
  // them even if the key were granted — a role that only ticked "Staff" would leave
  // the member with zero usable access ("no access yet"). Their pages remain
  // accessible to full ADMINs (who bypass permission checks).
];

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

/** Every capability key, e.g. "customers.view". */
export const CAPABILITY_PERMISSION_KEYS: string[] = SECTIONS.flatMap((s) =>
  s.capabilities.map((c) => `${s.key}.${c}`),
);

/** Every field (column) key, e.g. "subscriptions.field.price". */
export const FIELD_PERMISSION_KEYS: string[] = SECTIONS.flatMap((s) =>
  (s.fields ?? []).map((f) => `${s.key}.field.${f.key}`),
);

/** All assignable permission keys — capabilities + field/column sub-permissions. */
export const ALL_PERMISSION_KEYS: string[] = [
  ...CAPABILITY_PERMISSION_KEYS,
  ...FIELD_PERMISSION_KEYS,
];

const ASSIGNABLE_KEY_SET = new Set(ALL_PERMISSION_KEYS);

/**
 * Drop any permission keys that are no longer assignable — e.g. keys for a
 * section that was removed from the matrix. Applied on every auth read so a
 * removed section can't keep authorizing a role/user whose stored `permissions`
 * still contain its (now-orphaned) keys.
 */
export function sanitizePermissions(permissions: string[] | null | undefined): string[] {
  return (permissions ?? []).filter((p) => ASSIGNABLE_KEY_SET.has(p));
}

export function hasCapability(
  permissions: string[],
  section: string,
  capability: Capability = "view",
): boolean {
  return permissions.includes(`${section}.${capability}`);
}

/** Column-level check — true when the role may see the given table column. */
export function hasField(permissions: string[], section: string, field: string): boolean {
  return permissions.includes(`${section}.field.${field}`);
}

export function sectionPermissions(section: string): string[] {
  const def = SECTIONS.find((s) => s.key === section);
  if (!def) return [];
  return [
    ...def.capabilities.map((c) => `${section}.${c}`),
    ...(def.fields ?? []).map((f) => `${section}.field.${f.key}`),
  ];
}
