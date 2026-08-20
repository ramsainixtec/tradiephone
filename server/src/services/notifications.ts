import { prisma } from "../prisma.js";
import { publishToUser, publishToAdmins } from "./events.js";

export interface NotificationInput {
  type: string; // missed_call | new_lead | billing | agent | system
  title: string;
  message?: string;
  link?: string;
}

/**
 * Create an in-app notification for a user. Best-effort — never throws, so callers
 * can fire it with `void notify(...)` without their own try/catch.
 */
export async function notify(userId: string, n: NotificationInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId,
        type: n.type,
        title: n.title,
        message: n.message ?? "",
        link: n.link ?? null,
      },
    });
    // Push a live nudge so the owner's open tabs refresh instantly (no polling),
    // and admin dashboards reflect the new activity in aggregate. Payload is just
    // the type tag — clients re-fetch only what the current screen shows.
    publishToUser(userId, { type: n.type });
    publishToAdmins({ type: n.type });
  } catch {
    /* notifications must never break the action that triggered them */
  }
}

/** Fan a notification out to every admin (e.g. new signups). Best-effort. */
export async function notifyAdmins(n: NotificationInput): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    if (!admins.length) return;
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type: n.type,
        title: n.title,
        message: n.message ?? "",
        link: n.link ?? null,
      })),
    });
    // Live nudge to every admin/staff tab (e.g. a new signup) — no polling needed.
    publishToAdmins({ type: n.type });
  } catch {
    /* best-effort */
  }
}

export async function listNotifications(userId: string, limit = 50) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Mark one notification read — scoped to the owner so users can't touch others'. */
export async function markNotificationRead(userId: string, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, userId },
    data: { read: true },
  });
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

export async function clearNotifications(userId: string): Promise<void> {
  await prisma.notification.deleteMany({ where: { userId } });
}
