import { prisma } from "../prisma.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { getEffective } from "./settings.js";

/* ------------------------------------------------------------------ *
 *  System email templates.
 *  Code-seeded defaults for every email the platform already sends.
 *  Admins edit subject/body/enabled from Admin → System Emails; the
 *  senders render through renderEmail() so edits take effect live.
 *  Body is plain text with {{variables}} rendered to HTML on send and
 *  wrapped in the editable header/footer.
 * ------------------------------------------------------------------ */

export type EmailAudience = "User" | "Admin" | "Staff";

export interface EmailTemplateDef {
  key: string;
  category: string;
  name: string;
  description: string;
  audience: EmailAudience;
  /** Cannot be turned off (transactional/security). */
  alwaysOn: boolean;
  subject: string;
  body: string;
  /** Variable names (without braces) this template understands. */
  variables: string[];
}

/** Globals available to every template (pulled from branding settings). */
export const GLOBAL_VARS = ["app_name", "support_email"];

/**
 * Every email the system currently sends, as an editable template. Bodies use
 * {{snake_case}} placeholders; empty values collapse (their paragraph is
 * dropped) so optional lines like {{reason}} disappear cleanly.
 */
export const EMAIL_TEMPLATE_DEFS: EmailTemplateDef[] = [
  /* ----------------------------- Authentication ----------------------------- */
  {
    key: "email_verification",
    category: "Authentication",
    name: "Email Verification Code",
    description: "Sent when a user must verify their email with a 6-digit code.",
    audience: "User",
    alwaysOn: true,
    subject: "Verify your {{app_name}} email",
    body:
      "Use this code to verify your email and finish creating your account:\n\n" +
      "{{code}}\n\n" +
      "This code expires in {{expiry_minutes}} minutes. If you didn't request this, you can safely ignore this email.",
    variables: ["code", "expiry_minutes"],
  },
  {
    key: "password_reset",
    category: "Authentication",
    name: "Password Reset Code",
    description: "Sent when a user requests a password reset code.",
    audience: "User",
    alwaysOn: true,
    subject: "Reset your {{app_name}} password",
    body:
      "Use this code to reset your password:\n\n" +
      "{{code}}\n\n" +
      "This code expires in {{expiry_minutes}} minutes. If you didn't request this, you can safely ignore this email.",
    variables: ["code", "expiry_minutes"],
  },
  {
    key: "impersonation_pin_reset",
    category: "Authentication",
    name: "Access PIN Reset Code",
    description:
      "Sent to an admin who has forgotten the PIN that guards signing in as a customer.",
    audience: "Admin",
    // Security mail, and the ONLY self-serve way back in — an admin who
    // switched it off and then forgot the PIN would be left with a shell script.
    alwaysOn: true,
    subject: "Your {{app_name}} access PIN reset code",
    body:
      "Use this code to set a new PIN for signing in as a customer:\n\n" +
      "{{code}}\n\n" +
      "This code expires in {{expiry_minutes}} minutes. If you didn't request this, ignore this email — your PIN has not changed. It is worth checking who has admin access, since only a signed-in admin can ask for this.",
    variables: ["code", "expiry_minutes"],
  },

  /* -------------------------------- Account -------------------------------- */
  {
    key: "number_assigned",
    category: "Account",
    name: "AI Receptionist Live",
    description: "Sent when a customer claims their dedicated number and their AI goes live.",
    audience: "User",
    alwaysOn: false,
    subject: "Your AI receptionist is live 🎉",
    body:
      "Hi {{user_name}},\n\n" +
      "Your AI receptionist{{business_suffix}} has been set up. Your dedicated AI number is {{number}}.\n\n" +
      "Already have a number your customers know? Keep it — just forward its calls to your AI:\n\n" +
      "1. On the phone with your existing number, open the keypad.\n" +
      "2. Forward your calls to {{number}} — on most mobiles, dial *21*{{number_plain}}# and press call.\n" +
      "3. That's it — your AI now answers calls to your existing number too.\n\n" +
      "Need step-by-step help for your carrier (or want the AI to only pick up missed calls)? Open forwarding setup: {{forwarding_url}}\n\n" +
      "You're on a free trial — it runs until you reach {{trial_minutes}} call minutes or {{trial_days}} days, whichever comes first. After that your plan starts automatically, and you can cancel anytime from your dashboard.\n\n" +
      "Log in to start handling calls.",
    variables: [
      "user_name",
      "business_suffix",
      "number",
      "number_plain",
      "trial_minutes",
      "trial_days",
      "forwarding_url",
    ],
  },
  {
    key: "account_suspended",
    category: "Account",
    name: "Account Suspended",
    description: "Sent when an admin suspends a user's account.",
    audience: "User",
    alwaysOn: false,
    subject: "Your {{app_name}} account has been suspended",
    body:
      "Hi {{user_name}},\n\n" +
      "Your {{app_name}} account has been suspended by our team. Your AI receptionist is now offline and you won't be able to sign in while the suspension is active.\n\n" +
      "{{reason}}\n\n" +
      "If you think this is a mistake or want to restore your account, please contact us at {{support_email}}.",
    variables: ["user_name", "reason"],
  },
  {
    key: "account_reactivated",
    category: "Account",
    name: "Account Reactivated",
    description: "Sent when an admin lifts a user's suspension.",
    audience: "User",
    alwaysOn: false,
    subject: "Your {{app_name}} account has been reactivated",
    body:
      "Hi {{user_name}},\n\n" +
      "Good news — your {{app_name}} account has been reactivated. You can sign in again, and your AI receptionist is back online.\n\n" +
      "Sign in to your dashboard: {{login_url}}",
    variables: ["user_name", "login_url"],
  },
  {
    key: "grace_started",
    category: "Account",
    name: "Grace Period Started",
    description: "Sent when a lapsed trial keeps the number reserved for a grace window.",
    audience: "User",
    alwaysOn: false,
    subject: "Your number is reserved for {{grace_days}} more days",
    body:
      "Hi {{user_name}},\n\n" +
      "Your free trial has ended. As a courtesy we've given you a {{grace_days}}-day grace period — your dedicated number {{number}} stays reserved for you until {{grace_until}}.\n\n" +
      "Pick a plan before then to keep your number and switch your AI back on. If you don't, we'll release the number on {{grace_until}} and it may be given to someone else.",
    variables: ["user_name", "grace_days", "number", "grace_until"],
  },
  {
    key: "grace_warning",
    category: "Account",
    name: "Grace Period Reminder",
    description: "Reminder during the grace window that the number will be released soon.",
    audience: "User",
    alwaysOn: false,
    subject: "{{days_remaining}} days left to keep your number",
    body:
      "Hi {{user_name}},\n\n" +
      "You have {{window}} left to keep your dedicated number {{number}}.\n\n" +
      "Pick a plan now and your AI starts answering again on the same number. If we don't hear from you, your number will be released on {{grace_until}}.",
    variables: ["user_name", "window", "number", "grace_until", "days_remaining"],
  },
  {
    key: "grace_final_warning",
    category: "Account",
    name: "Grace Period Final Warning",
    description: "Last-chance warning ~24h before the reserved number is released.",
    audience: "User",
    alwaysOn: false,
    subject: "Last chance — your number is released tomorrow",
    body:
      "Hi {{user_name}},\n\n" +
      "You have less than 24 hours left to keep your dedicated number {{number}}.\n\n" +
      "Pick a plan now and your AI starts answering again on the same number. If we don't hear from you, your number will be released on {{grace_until}}.",
    variables: ["user_name", "number", "grace_until"],
  },
  {
    key: "grace_ended",
    category: "Account",
    name: "Number Released",
    description: "Sent when the grace window lapses and the number is released.",
    audience: "User",
    alwaysOn: false,
    subject: "Your reserved number has been released",
    body:
      "Hi {{user_name}},\n\n" +
      "Your grace period has ended, so we've released your number {{number}} back to the pool.\n\n" +
      "You can still pick a plan anytime — you'll be assigned a fresh number and your AI will be back online.",
    variables: ["user_name", "number"],
  },

  /* -------------------------------- Billing -------------------------------- */
  {
    key: "plan_activated",
    category: "Billing",
    name: "Plan Activated",
    description: "Sent when a free trial converts to a paid plan.",
    audience: "User",
    alwaysOn: false,
    subject: "Your {{plan_name}} plan is now active",
    body:
      "Hi {{user_name}},\n\n" +
      "Your free trial has ended and your {{plan_name}} plan is now active — your card has been charged and your AI receptionist keeps running without interruption.\n\n" +
      "Plan: {{plan_name}}\n" +
      "Includes: {{included_minutes}}\n" +
      "{{number_line}}" +
      "{{renewal_line}}\n\n" +
      "You can manage or cancel your subscription anytime from your dashboard billing settings.",
    variables: ["user_name", "plan_name", "included_minutes", "number_line", "renewal_line"],
  },
  {
    key: "usage_threshold",
    category: "Billing",
    name: "Usage Threshold Alert",
    description: "Warns the owner when call-minute usage crosses 50/80/90% of the allowance.",
    audience: "User",
    alwaysOn: false,
    subject: "You've used {{threshold}}% of your call minutes",
    body:
      "Hi {{user_name}},\n\n" +
      "{{lead}}\n\n" +
      "Used: {{minutes_used}} of {{minutes_allocated}} minutes\n" +
      "Remaining: {{minutes_remaining}} minutes\n\n" +
      "{{cta}}",
    variables: [
      "user_name",
      "threshold",
      "lead",
      "minutes_used",
      "minutes_allocated",
      "minutes_remaining",
      "cta",
    ],
  },

  /* --------------------------------- Calls --------------------------------- */
  {
    key: "call_summary",
    category: "Calls",
    name: "Call Summary",
    description: "Post-call summary to the owner with AI summary, recording link and transcript.",
    audience: "User",
    alwaysOn: false,
    subject: "New call from {{caller_name}}",
    body:
      "New call from {{caller_name}}\n\n" +
      "{{summary_block}}\n\n" +
      "{{recording_block}}\n\n" +
      "{{transcript_block}}",
    variables: ["caller_name", "summary_block", "recording_block", "transcript_block"],
  },

  /* --------------------------------- Staff --------------------------------- */
  {
    key: "staff_welcome",
    category: "Staff",
    name: "Staff Account Created",
    description: "Sent to a new staff member with their login credentials and permissions.",
    audience: "Staff",
    alwaysOn: false,
    subject: "Your staff account has been created",
    body:
      "Hi {{user_name}},\n\n" +
      "A staff account has been created for you. Use these credentials to log in:\n\n" +
      "Email: {{user_email}}\n" +
      "Password: {{password}}\n\n" +
      "You have access to the following admin sections:\n{{permissions}}\n\n" +
      "Log in to your account: {{login_url}}\n\n" +
      "For your security, please change your password after your first login.",
    variables: ["user_name", "user_email", "password", "permissions", "login_url"],
  },
  {
    key: "staff_permissions_updated",
    category: "Staff",
    name: "Staff Permissions Updated",
    description: "Sent when an admin changes a staff member's role or permissions.",
    audience: "Staff",
    alwaysOn: false,
    subject: "Your role & permissions have been updated",
    body:
      "Hi {{user_name}},\n\n" +
      "Your role has been changed from {{old_role}} to {{new_role}}.\n\n" +
      "You now have access to the following admin sections:\n{{permissions}}\n\n" +
      "Log in to your account: {{login_url}}",
    variables: ["user_name", "old_role", "new_role", "permissions", "login_url"],
  },
  {
    key: "staff_role_permissions_updated",
    category: "Staff",
    name: "Role Permissions Updated",
    description:
      "Sent to every staff member on a role when an admin edits that role's permissions.",
    audience: "Staff",
    alwaysOn: false,
    subject: "Your role's permissions have been updated",
    body:
      "Hi {{user_name}},\n\n" +
      "The permissions for your role ({{role_name}}) have been updated. You now have access to:\n{{permissions}}\n\n" +
      "Log in to your account: {{login_url}}",
    variables: ["user_name", "role_name", "permissions", "login_url"],
  },
  {
    key: "staff_access_revoked",
    category: "Staff",
    name: "Staff Access Revoked",
    description: "Sent when an admin removes a staff member's access.",
    audience: "Staff",
    alwaysOn: false,
    subject: "Your staff access has been revoked",
    body:
      "Hi {{user_name}},\n\n" +
      "Your staff account has been removed and you no longer have admin access.\n\n" +
      "If you think this is a mistake, please contact us at {{support_email}}.",
    variables: ["user_name"],
  },
];

const DEF_BY_KEY = new Map(EMAIL_TEMPLATE_DEFS.map((d) => [d.key, d]));

/**
 * Template keys the recipient can unsubscribe from. These are non-essential
 * notification emails only — call summaries, usage-threshold alerts and the
 * grace/trial reminders. Security and account-critical emails (verification,
 * password reset, suspension/reactivation, staff) are deliberately excluded and
 * always send. When a template is unsubscribable, senders inject a tokenized
 * footer link + List-Unsubscribe header and skip delivery to opted-out users.
 */
export const UNSUBSCRIBABLE_KEYS = new Set<string>([
  "call_summary",
  "usage_threshold",
  "grace_started",
  "grace_warning",
  "grace_final_warning",
  "grace_ended",
]);

export function isUnsubscribable(key: string): boolean {
  return UNSUBSCRIBABLE_KEYS.has(key);
}

/* ------------------------------ Branding ------------------------------ */

const BRANDING_KEYS = {
  header: "email.header",
  footer: "email.footer",
  fromName: "email.fromName",
} as const;

/** App name + support email that every template can interpolate. */
export function emailGlobals(): { app_name: string; support_email: string } {
  return {
    app_name: getEffective("branding.appName").trim() || "tradiephone.ai",
    support_email: getEffective("smtp.from").match(/[\w.+-]+@[\w.-]+/)?.[0] || "support@tradiephone.ai",
  };
}

export function defaultHeaderHtml(): string {
  const { app_name } = emailGlobals();
  return (
    `<div style="background:#ffffff;padding:24px 32px;border-bottom:1px solid #eee;font-family:Arial,Helvetica,sans-serif">` +
    `<span style="font-size:20px;font-weight:700;color:#111">${escapeHtml(app_name)}</span>` +
    `</div>`
  );
}

export function defaultFooterHtml(): string {
  const { app_name, support_email } = emailGlobals();
  const year = new Date().getFullYear();
  // {{unsubscribe}} is filled in by renderEmail with the recipient's tokenized
  // unsubscribe line on notification emails, and blanked out on everything else.
  return (
    `<div style="background:#fafafa;padding:28px 32px;border-top:1px solid #ececec;font-family:Arial,Helvetica,sans-serif">` +
    `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#555">Need help? Reach us anytime at <a href="mailto:${escapeHtml(support_email)}" style="color:#2563eb;text-decoration:none">${escapeHtml(support_email)}</a>.</p>` +
    `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#888">Your AI receptionist — answering calls so you never miss a customer.</p>` +
    `<p style="margin:0;font-size:12px;line-height:1.5;color:#aaa">© ${year} ${escapeHtml(app_name)}. All rights reserved.</p>` +
    `{{unsubscribe}}` +
    `</div>`
  );
}

/** The unsubscribe line that renderEmail drops into the footer's {{unsubscribe}}
 *  marker on notification emails. Just the <p> (it lives inside the footer div),
 *  carrying the recipient's token — which the static footer HTML can't. */
export function unsubscribeLineHtml(unsubscribeUrl: string): string {
  const { app_name } = emailGlobals();
  return (
    `<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#aaa">You're receiving this because you have a ${escapeHtml(app_name)} account. ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#888;text-decoration:underline">Unsubscribe from these emails</a>.</p>`
  );
}

export async function getEmailBranding(): Promise<{ header: string; footer: string; fromName: string }> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: Object.values(BRANDING_KEYS) } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    header: byKey.get(BRANDING_KEYS.header) ?? defaultHeaderHtml(),
    footer: byKey.get(BRANDING_KEYS.footer) ?? defaultFooterHtml(),
    fromName: byKey.get(BRANDING_KEYS.fromName) ?? emailGlobals().app_name,
  };
}

export async function setEmailBranding(
  patch: Partial<{ header: string; footer: string; fromName: string }>,
): Promise<void> {
  const entries: [string, string][] = [];
  if (patch.header !== undefined) entries.push([BRANDING_KEYS.header, patch.header]);
  if (patch.footer !== undefined) entries.push([BRANDING_KEYS.footer, patch.footer]);
  if (patch.fromName !== undefined) entries.push([BRANDING_KEYS.fromName, patch.fromName]);
  for (const [key, value] of entries) {
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value, isSecret: false },
      create: { key, value, isSecret: false },
    });
  }
}

/* ------------------------------ Rendering ------------------------------ */

/** Replace {{var}} with escaped values. Unknown/empty vars become "". */
function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Turn a plain-text body into HTML paragraphs (blank line = new paragraph,
 *  single newline = <br>). Empty paragraphs (from collapsed optional vars) are
 *  dropped. Bare URLs and emails are linkified. */
function textToHtml(text: string): string {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paras
    .map((p) => {
      const lines = p.split(/\n/).map((l) => linkify(escapeHtml(l)));
      return `<p style="margin:0 0 16px;line-height:1.6;color:#333;font-size:15px">${lines.join("<br/>")}</p>`;
    })
    .join("");
}

function linkify(escaped: string): string {
  return escaped
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb">$1</a>')
    .replace(/\b([\w.+-]+@[\w.-]+\.\w+)\b/g, '<a href="mailto:$1" style="color:#2563eb">$1</a>');
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  enabled: boolean;
  alwaysOn: boolean;
}

/**
 * Render a template by key with the given variables. Falls back to the code
 * default when the DB row is missing (e.g. before the first seed). Variable
 * values are escaped; app_name/support_email are always injected.
 */
export async function renderEmail(
  key: string,
  vars: Record<string, string | number | undefined>,
  opts: { unsubscribeUrl?: string } = {},
): Promise<RenderedEmail | null> {
  const def = DEF_BY_KEY.get(key);
  const row = await prisma.emailTemplate.findUnique({ where: { key } }).catch(() => null);
  const tpl = row ?? def;
  if (!tpl) return null;

  const alwaysOn = def?.alwaysOn ?? row?.alwaysOn ?? false;
  const enabled = alwaysOn || (row?.enabled ?? true);

  // Keep values raw here — textToHtml() escapes every body line on render, so
  // escaping now would double-encode (e.g. "You've" -> "You&#39;ve" -> "You&amp;#39;ve",
  // which shows the literal "&#39;" in the email). The plain-text fallback also
  // needs the raw text.
  const merged: Record<string, string> = { ...emailGlobals() };
  for (const [k, v] of Object.entries(vars)) {
    merged[k] = v === undefined || v === null ? "" : String(v);
  }

  const subject = interpolate(tpl.subject, merged).trim();
  const bodyText = interpolate(tpl.body, merged);
  const branding = await getEmailBranding();
  // Fill the footer's {{unsubscribe}} marker with the recipient's unsubscribe line
  // on notification emails (blank on others). If a custom footer has no marker,
  // append the line so the (compliance-required) link is never dropped.
  const unsubLine = opts.unsubscribeUrl ? unsubscribeLineHtml(opts.unsubscribeUrl) : "";
  const footer = branding.footer.includes("{{unsubscribe}}")
    ? branding.footer.replace("{{unsubscribe}}", () => unsubLine)
    : branding.footer +
      (unsubLine
        ? `<div style="background:#fafafa;padding:0 32px 24px;font-family:Arial,Helvetica,sans-serif">${unsubLine}</div>`
        : "");
  const html =
    `<div style="max-width:600px;margin:0 auto;background:#ffffff">` +
    branding.header +
    `<div style="padding:28px 32px">${textToHtml(bodyText)}</div>` +
    footer +
    `</div>`;

  // Plain-text fallback (strip the placeholder markup, keep the interpolated body).
  let text = bodyText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  if (opts.unsubscribeUrl) text += `\n\n---\nUnsubscribe from these emails: ${opts.unsubscribeUrl}`;

  return { subject, html, text, enabled, alwaysOn };
}

/* ------------------------------ Seeding ------------------------------ */

/**
 * Insert any missing template rows from the code defaults. Never overwrites an
 * admin's edits to subject/body/enabled — only refreshes metadata (category,
 * name, description, audience, variables, alwaysOn) so those stay in sync.
 * Best-effort; safe to call on every boot.
 */
export async function seedEmailTemplates(): Promise<void> {
  for (const d of EMAIL_TEMPLATE_DEFS) {
    try {
      await prisma.emailTemplate.upsert({
        where: { key: d.key },
        update: {
          category: d.category,
          name: d.name,
          description: d.description,
          audience: d.audience,
          variables: [...GLOBAL_VARS, ...d.variables],
          alwaysOn: d.alwaysOn,
        },
        create: {
          key: d.key,
          category: d.category,
          name: d.name,
          description: d.description,
          audience: d.audience,
          subject: d.subject,
          body: d.body,
          variables: [...GLOBAL_VARS, ...d.variables],
          enabled: true,
          alwaysOn: d.alwaysOn,
        },
      });
    } catch {
      /* best-effort — a cold DB at boot shouldn't crash startup */
    }
  }
}
