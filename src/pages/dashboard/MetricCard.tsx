import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface MetricCardProps {
  title: string;
  value: ReactNode;
  /** Signed percentage trend vs the previous period. */
  trend?: number;
  /** Small caption under the value (e.g. "vs last period"). */
  caption?: string;
  /** The inline-SVG chart visual. */
  chart: ReactNode;
  /** Optional legend / footer row beneath the chart. */
  footer?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** When provided, the whole card becomes a button that drills down. */
  onClick?: () => void;
  /** Hex accent that tints the icon chip + top hairline. */
  accent?: string;
  /** Place the chart beside the value instead of below it. For single-visual
   *  cards (a gauge, a donut) this keeps the card short; cards whose chart is a
   *  full-width series must stay stacked. */
  chartSide?: boolean;
  /** Stagger index for the entrance animation. */
  index?: number;
}

export function MetricCard({
  title,
  value,
  trend,
  caption,
  chart,
  footer,
  icon,
  className,
  onClick,
  accent = "#EB7D00",
  chartSide = false,
  index = 0,
}: MetricCardProps) {
  const showTrend = typeof trend === "number";
  const up = (trend ?? 0) >= 0;
  const interactive = typeof onClick === "function";

  return (
    <Card
      className={cn(
        "lift card-glass animate-rise group relative flex flex-col overflow-hidden",
        interactive && "cursor-pointer",
        className,
      )}
      style={{ animationDelay: `${index * 60}ms` }}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {/* top accent hairline */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-70"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />

      <CardContent className="relative flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            {icon && (
              <span
                className="flex size-9 items-center justify-center rounded-xl [&_svg]:size-[18px]"
                style={{ background: `${accent}1f`, color: accent }}
              >
                {icon}
              </span>
            )}
            <span className="text-[15px] font-semibold tracking-tight text-foreground">{title}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {showTrend && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold",
                  up ? "bg-success-tint text-success" : "bg-danger-tint text-danger",
                )}
              >
                {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                {Math.abs(trend ?? 0).toFixed(1)}%
              </span>
            )}
            {interactive && (
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
            )}
          </div>
        </div>

        <div
          className={cn(
            "mt-3.5 flex justify-between gap-3",
            chartSide ? "flex-1 items-center" : "items-end",
          )}
        >
          <div>
            <div className="text-[26px] font-bold leading-none tracking-tight">{value}</div>
            {caption && <p className="mt-1.5 text-xs text-muted-foreground">{caption}</p>}
          </div>
          {chartSide && <div className="shrink-0">{chart}</div>}
        </div>

        {!chartSide && <div className="mt-4 flex-1">{chart}</div>}

        {footer && <div className="mt-3 border-t border-border/70 pt-3">{footer}</div>}
      </CardContent>
    </Card>
  );
}

/** Tiny colored-dot legend row used inside metric cards. */
export function LegendDot({ color, label, value }: { color: string; label: string; value?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-2 rounded-full ring-2 ring-white" style={{ backgroundColor: color }} />
      <span>{label}</span>
      {value !== undefined && <span className="font-medium text-foreground">{value}</span>}
    </span>
  );
}
