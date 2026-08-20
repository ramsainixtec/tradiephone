import { prisma } from "../prisma.js";

/**
 * Accrue a reseller's referral commission for a paid Stripe invoice — if the
 * paying customer was referred by a reseller. Idempotent on the invoice id, so
 * the Stripe webhook AND the local reconcile path can both call it without
 * double-counting. Best-effort; never throws.
 */
export async function accrueCommissionForInvoice(opts: {
  invoiceId: string;
  customerId: string;
  amountPaidCents: number;
}): Promise<void> {
  try {
    if (!opts.invoiceId || !opts.customerId || opts.amountPaidCents <= 0) return;

    const already = await prisma.commission.findFirst({ where: { stripeInvoiceId: opts.invoiceId } });
    if (already) return;

    const profile = await prisma.profile.findFirst({
      where: { stripeCustomerId: opts.customerId },
      select: { userId: true, user: { select: { referredById: true } } },
    });
    const referredById = profile?.user?.referredById;
    if (!referredById) return;

    const reseller = await prisma.user.findUnique({
      where: { id: referredById },
      select: { commissionPercent: true },
    });
    const percent = reseller?.commissionPercent ?? 0;
    const amountCents = Math.round(opts.amountPaidCents * (percent / 100));
    if (amountCents <= 0) return;

    await prisma.commission.create({
      data: {
        resellerId: referredById,
        customerId: profile!.userId,
        amountCents,
        percent,
        invoiceAmountCents: opts.amountPaidCents,
        stripeInvoiceId: opts.invoiceId,
        status: "pending",
      },
    });
  } catch {
    /* best-effort — a missed accrual is reconciled by the webhook / next call */
  }
}
