import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SectionMeta } from "./sectionMeta";

/** Tints for a FieldGroup's leading icon. Semantic-ish rather than decorative:
 *  brand for the assistant's own identity, and distinct hues for the separate
 *  faculties (voice, behaviour, language) so a long page is scannable by colour
 *  as well as by heading. */
const GROUP_TONES = {
  brand: { tint: "var(--color-primary-tint)", ink: "var(--color-primary-ink)" },
  voice: { tint: "hsl(262 72% 58% / 0.13)", ink: "hsl(262 62% 50%)" },
  service: { tint: "hsl(262 72% 58% / 0.13)", ink: "hsl(262 62% 50%)" },
  tuning: { tint: "hsl(217 84% 55% / 0.13)", ink: "hsl(217 74% 46%)" },
  faq: { tint: "hsl(217 84% 55% / 0.13)", ink: "hsl(217 74% 46%)" },
  capture: { tint: "var(--color-success-tint)", ink: "var(--color-success)" },
  language: { tint: "var(--color-success-tint)", ink: "var(--color-success)" },
  neutral: { tint: "var(--color-muted)", ink: "var(--color-muted-foreground)" },
} as const;

export type GroupTone = keyof typeof GROUP_TONES;

/** Inline style that ties a card's action button to its icon tone, so the
 *  "+ Add" control reads as belonging to the card it sits on. */
export function toneButtonStyle(tone: GroupTone) {
  const { tint, ink } = GROUP_TONES[tone];
  return { borderColor: ink, color: ink, background: tint } as const;
}

/** Dashed placeholder shown when a card's list is still empty. Clickable —
 *  it IS the "add your first one" affordance, not just a message. */
export function EmptyHint({
  icon,
  tone,
  onClick,
  children,
}: {
  icon: ReactNode;
  tone: GroupTone;
  onClick?: () => void;
  children: ReactNode;
}) {
  const { ink } = GROUP_TONES[tone];
  const inner = (
    <>
      <span className="mt-0.5 shrink-0 [&_svg]:size-5" style={{ color: ink }}>
        {icon}
      </span>
      <span className="text-sm leading-relaxed text-muted-foreground">{children}</span>
    </>
  );
  const base =
    "flex w-full items-start gap-3 rounded-xl border border-dashed px-4 py-3.5 text-left transition-colors";
  if (!onClick) {
    return (
      <div className={cn(base, "border-border")}>{inner}</div>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn(base, "border-border hover:bg-muted/40")}>
      {inner}
    </button>
  );
}

/** Consistent header for each numbered, color-coded AI Brain section. */
export function SectionShell({
  meta,
  children,
}: {
  meta: SectionMeta;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 items-center justify-center rounded-xl text-sm font-bold text-white"
          style={{ backgroundColor: `var(${meta.colorVar})` }}
        >
          {meta.index}
        </div>
        <div>
          <h2 className="text-lg font-semibold leading-tight">{meta.label}</h2>
          <p className="text-sm text-muted-foreground">{meta.blurb}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/** A titled sub-block within a section. */
export function FieldGroup({
  title,
  description,
  children,
  action,
  icon,
  tone = "neutral",
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  /** Leading glyph for the card header. Omit for an unadorned group. */
  icon?: ReactNode;
  tone?: GroupTone;
}) {
  const { tint, ink } = GROUP_TONES[tone];
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-card p-5 shadow-[var(--shadow-soft)]">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className={cn("flex min-w-0 gap-3", icon ? "items-start" : "items-center")}>
          {icon && (
            <span
              className="grid size-10 shrink-0 place-items-center rounded-xl [&_svg]:size-5"
              style={{ background: tint, color: ink }}
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="font-semibold">{title}</h3>
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
