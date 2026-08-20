import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/jwt.js";
import { unauthorized, forbidden } from "../lib/http.js";
import { prisma } from "../prisma.js";
import type { Capability } from "../lib/permissions.js";
import { sanitizePermissions } from "../lib/permissions.js";

// Augment Express Request with the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

/**
 * Require a valid JWT AND that the user still exists in the DB.
 * (A stateless token alone stays valid after a user is deleted/disabled;
 * the DB check forces those sessions to fail immediately with 401.)
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next(unauthorized("Missing bearer token"));

  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(unauthorized("Invalid or expired token"));
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, permissions: true },
    });
    if (!user) return next(unauthorized("Account no longer exists"));
    // Use the live row (role/email stay fresh, not whatever the token baked in).
    // Sanitize so keys for any removed section can never authorize, even if an
    // old role/user row still has them stored.
    req.user = {
      sub: user.id,
      email: user.email,
      role: user.role,
      permissions: sanitizePermissions(user.permissions),
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Require an authenticated ADMIN user (strict — STAFF does not pass). */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== "ADMIN") return next(forbidden("Admin access required"));
  next();
}

/** Require an ADMIN or STAFF user (gates the admin area). */
export function requireAdminOrStaff(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== "ADMIN" && req.user.role !== "STAFF") {
    return next(forbidden("Admin access required"));
  }
  next();
}

/**
 * Require a specific section + capability. ADMINs always pass; STAFF must
 * have the `section.capability` key in their `permissions` array.
 *
 * Usage: requirePermission("customers", "view")
 *        requirePermission("customers", "delete")
 *        requirePermission("settings")  // defaults to "view"
 */
export function requirePermission(section: string, capability: Capability = "view") {
  const key = `${section}.${capability}`;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === "ADMIN") return next();
    if (req.user.role === "STAFF" && req.user.permissions.includes(key)) {
      return next();
    }
    next(forbidden("You don't have permission to access this section"));
  };
}

/** Require an authenticated RESELLER user. */
export function requireReseller(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== "RESELLER") return next(forbidden("Reseller access required"));
  next();
}
