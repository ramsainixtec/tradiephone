import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Flag,
  ListChecks,
  PhoneMissed,
  RotateCcw,
  Search,
  Tag,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageSkeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/utils";
import { useCallsStore } from "@/stores/useCallsStore";
import { useLiveTick } from "@/hooks/useLiveData";
import type { CallIntent, CallOutcome } from "@/types";
import {
  CALL_INTENTS,
  computeStats,
  DATE_PRESET_LABELS,
  type DatePreset,
  INTENT_HINTS,
  INTENT_LABELS,
  withinPreset,
} from "./callUtils";
import { CallTable } from "./CallTable";
import { CallDetailPanel } from "./CallDetailPanel";

type OutcomeFilter = "all" | CallOutcome;
type IntentFilter = "all" | CallIntent;

/** Semantic tones for the stat strip. Each tile owns a tint + an ink colour,
 *  so the four read as a set rather than four unrelated colours: brand for the
 *  headline count, success/danger for the two rates, and a calm neutral blue
 *  for duration, which is a measurement rather than a judgement. */
const STAT_TONES = {
  brand: { tint: "var(--color-primary-tint)", ink: "var(--color-primary-ink)" },
  success: { tint: "var(--color-success-tint)", ink: "var(--color-success)" },
  info: { tint: "hsl(217 84% 55% / 0.12)", ink: "hsl(217 74% 46%)" },
  danger: { tint: "var(--color-danger-tint)", ink: "var(--color-danger)" },
} as const;

function StatTile({
  label,
  value,
  caption,
  icon,
  tone,
  index,
}: {
  label: string;
  value: string;
  caption: string;
  icon: React.ReactNode;
  tone: keyof typeof STAT_TONES;
  index: number;
}) {
  const { tint, ink } = STAT_TONES[tone];
  return (
    <div
      className="animate-rise flex items-center gap-3.5 rounded-[var(--radius-card)] border border-border p-4"
      style={{ background: tint, animationDelay: `${index * 70}ms` }}
    >
      <span
        className="grid size-11 shrink-0 place-items-center rounded-full bg-card [&_svg]:size-5"
        style={{ color: ink }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-0.5 text-2xl font-bold leading-none tracking-tight tabular-nums">{value}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{caption}</p>
      </div>
    </div>
  );
}

export default function CallInboxPage() {
  const calls = useCallsStore((s) => s.calls);
  const loaded = useCallsStore((s) => s.loaded);
  const selectedId = useCallsStore((s) => s.selectedId);
  const select = useCallsStore((s) => s.select);

  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [intent, setIntent] = useState<IntentFilter>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  // Newest-first by default — the inbox is read as "what just happened".
  const [dateDesc, setDateDesc] = useState(true);

  // Keep the inbox live while it's open: refetch the call logs on mount and on
  // every live tick (the global heartbeat also ticks on tab focus), so new calls
  // appear without a manual reload. Scoped to this page — other routes don't pull
  // the full call list they never display.
  const liveTick = useLiveTick();
  useEffect(() => {
    void useCallsStore.getState().hydrate();
  }, [liveTick]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const q = search.trim().toLowerCase();
    return calls.filter((call) => {
      if (outcome !== "all" && call.outcome !== outcome) return false;
      if (intent !== "all" && call.intent !== intent) return false;
      if (!withinPreset(call, datePreset, now)) return false;
      if (q) {
        const haystack = `${call.summary} ${call.callerName} ${call.callerNumber}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [calls, search, outcome, intent, datePreset]);

  // Sort after filtering, and on a copy: `filtered` is memoised, so sorting it
  // in place would mutate the cached array and make the order depend on render
  // count rather than on `dateDesc`.
  const sorted = useMemo(() => {
    const dir = dateDesc ? -1 : 1;
    return [...filtered].sort(
      (x, y) =>
        dir * (new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime()),
    );
  }, [filtered, dateDesc]);

  const stats = useMemo(() => computeStats(filtered), [filtered]);
  const selectedCall = useMemo(
    () => calls.find((c) => c.id === selectedId) ?? null,
    [calls, selectedId],
  );

  const filtersActive =
    Boolean(search.trim()) || outcome !== "all" || intent !== "all" || datePreset !== "all";
  const resetFilters = () => {
    setSearch("");
    setOutcome("all");
    setIntent("all");
    setDatePreset("all");
  };

  if (!loaded && calls.length === 0) {
    return <PageSkeleton variant="table" />;
  }

  return (
    <div>
      <PageHeader title="Call Logs" subtitle="Every call, transcribed and analyzed." />

      {/* Filter bar. Each control carries its own leading glyph, positioned
          outside the trigger rather than inside it — the shared SelectTrigger
          line-clamps its direct span children, which would break a flex row
          holding an icon and the value. */}
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search call summaries, callers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            aria-label="Search call summaries and callers"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:flex lg:items-center">
          <div className="relative lg:w-44">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Select value={datePreset} onValueChange={(v) => setDatePreset(v as DatePreset)}>
              <SelectTrigger aria-label="Date range" className="pl-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DATE_PRESET_LABELS) as DatePreset[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {DATE_PRESET_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Category — the filter owners reach for first ("just show me bookings"). */}
          <div className="relative lg:w-52">
            <Tag className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Select value={intent} onValueChange={(v) => setIntent(v as IntentFilter)}>
              <SelectTrigger aria-label="Call category" className="pl-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {CALL_INTENTS.map((key) => (
                  <SelectItem key={key} value={key} hint={INTENT_HINTS[key]}>
                    {INTENT_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="relative lg:w-44">
            <Flag className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Select value={outcome} onValueChange={(v) => setOutcome(v as OutcomeFilter)}>
              <SelectTrigger aria-label="Outcome" className="pl-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Outcomes</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="missed">Missed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="voicemail">Voicemail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <button
            type="button"
            onClick={resetFilters}
            disabled={!filtersActive}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-45 disabled:hover:bg-background focus-visible:focus-ring"
          >
            <RotateCcw className="size-4" /> Reset
          </button>
        </div>
      </div>

      {/* Stat strip */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          index={0}
          tone="brand"
          label="Total Calls"
          value={String(stats.total)}
          caption={DATE_PRESET_LABELS[datePreset]}
          icon={<ListChecks />}
        />
        <StatTile
          index={1}
          tone="success"
          label="Success Rate"
          value={`${stats.successPct}%`}
          caption="Completed calls"
          icon={<CheckCircle2 />}
        />
        <StatTile
          index={2}
          tone="info"
          label="Avg Duration"
          value={formatDuration(stats.avgCompletedSec)}
          caption="Average talk time"
          icon={<Clock />}
        />
        <StatTile
          index={3}
          tone="danger"
          label="Missed Rate"
          value={`${stats.missedPct}%`}
          caption="Missed calls"
          icon={<PhoneMissed />}
        />
      </div>

      <CallTable
        calls={sorted}
        dateDesc={dateDesc}
        onToggleDateSort={() => setDateDesc((d) => !d)}
        selectedId={selectedId}
        onSelect={(id) => select(id)}
        filtersActive={filtersActive}
        onClearFilters={resetFilters}
      />

      {selectedCall && (
        <CallDetailPanel
          call={selectedCall}
          onClose={() => select(null)}
        />
      )}
    </div>
  );
}
