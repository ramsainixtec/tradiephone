import type { Profile, User } from "@prisma/client";
import { sanitizePermissions } from "./permissions.js";

/** Shape returned to the client for the authenticated user. */
export function serializeUser(
  user: User & { profile?: Profile | null; staffRole?: { name: string } | null },
) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    // Strip keys for any removed section so the client never sees (or gates on)
    // a permission that's no longer assignable.
    permissions: sanitizePermissions(user.permissions),
    // The assigned StaffRole's display name (e.g. "Support Agent") so a staff
    // member's own panel can show their role title, not the generic "Staff".
    // Null for admins/customers/resellers or a staff member with no role.
    staffRoleName: user.staffRole?.name ?? null,
    plan: user.profile?.plan ?? "free",
    profile: user.profile ?? null,
  };
}
