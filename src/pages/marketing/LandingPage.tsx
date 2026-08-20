import { useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Calendar,
  Clock,
  DollarSign,
  Filter,
  Frown,
  Phone,
  PhoneCall,
  Play,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UserRound,
} from "lucide-react";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { HowItWorksDialog } from "@/components/marketing/HowItWorksDialog";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- *
 *  "Same call. Better outcome." — a split comparison hero.
 *
 *  Left tells the cost of a missed call, right shows the same call handled by
 *  the AI receptionist, and the middle column carries the pitch and the CTA.
 *
 *  Geometry note: from `lg` up this renders at a fixed 1445px design width and
 *  `.lp-page` (index.css) scales the whole page with `zoom`, so the pinned
 *  offsets below — chip stacks, handwritten notes, avatars hanging off the
 *  phone frames — hold their exact relationships at every desktop size. Below
 *  `lg` the same pieces unstack into a normal responsive column.
 * -------------------------------------------------------------------------- */

/** Staggered entrance — pairs with the shared .lp-in keyframes. */
const rise = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

/* ----------------------------- shared pieces ----------------------------- */

/** Rounded phone body. Children render on the white "screen"; the screen does
 *  not clip, so chat avatars can hang off the bezel the way the design shows. */
function PhoneShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative h-[460px] w-[250px] shrink-0 rounded-[44px] border border-[#EDEFF3]",
        "bg-gradient-to-b from-white to-[#F5F6F9] p-[13px]",
        "shadow-[0_2px_4px_rgba(15,23,42,0.03),0_28px_60px_-28px_rgba(15,23,42,0.28)]",
        className,
      )}
    >
      <div className="relative h-full w-full rounded-[32px] bg-white">{children}</div>
    </div>
  );
}

/** The small uppercase eyebrow above each comparison headline. */
function Eyebrow({ tone, children }: { tone: "loss" | "win"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[24px] items-center rounded-full px-[11px] text-[10.5px] font-bold uppercase tracking-[0.09em]",
        tone === "loss" ? "bg-[#FDE7E7] text-[#E5484D]" : "bg-[#DCFCE7] text-[#16A34A]",
      )}
    >
      {children}
    </span>
  );
}

/** Outcome chip — the red "what you lost" and green "what you gained" cards
 *  floating either side of the phones. */
function OutcomeChip({
  tone,
  icon: Icon,
  label,
  delay,
}: {
  tone: "loss" | "win";
  icon: typeof Frown;
  label: string;
  delay: number;
}) {
  return (
    <div
      className={cn(
        "lp-float flex h-[72px] items-center gap-3 rounded-2xl border px-4",
        tone === "loss" ? "border-[#FADCDC] bg-[#FDF2F2]" : "border-[#D3F3DF] bg-[#F1FBF5]",
      )}
      style={{ "--lp-delay": `${delay}ms` } as CSSProperties}
    >
      <Icon
        className={cn("size-[18px] shrink-0", tone === "loss" ? "text-[#E5484D]" : "text-[#22A45D]")}
        strokeWidth={1.9}
      />
      <span className="text-[12.5px] font-medium leading-[1.32] text-[#3C4657]">{label}</span>
    </div>
  );
}

/** Chat avatar that sits just outside the phone bezel. */
function ChatAvatar({ kind }: { kind: "caller" | "ai" }) {
  return (
    <span
      className={cn(
        "grid size-[28px] place-items-center rounded-full border shadow-[0_2px_6px_rgba(15,23,42,0.06)]",
        kind === "caller" ? "border-[#EDEFF3] bg-[#F4F5F7]" : "border-[#FBDDC2] bg-white",
      )}
    >
      {kind === "caller" ? (
        <UserRound className="size-[14px] text-[#98A1AE]" strokeWidth={2} />
      ) : (
        <Sparkles className="size-[13px] text-[#F97316]" strokeWidth={2} />
      )}
    </span>
  );
}

/* ------------------------------- page data ------------------------------- */

const LOSS_CHIPS = [
  { icon: Frown, label: "Goes to voicemail" },
  { icon: DollarSign, label: "Lost lead" },
  { icon: TrendingDown, label: "Revenue lost" },
] as const;

const WIN_CHIPS = [
  { icon: UserRound, label: "Lead captured" },
  { icon: Calendar, label: "Job booked" },
  { icon: TrendingUp, label: "Business grows" },
] as const;

/** Live-call waveform. Fixed, so the silhouette is part of the design rather
 *  than a different picture on every render. */
const WAVE = [
  0.18, 0.32, 0.5, 0.28, 0.62, 0.42, 0.78, 0.55, 0.9, 0.66, 0.44, 0.82, 0.6, 0.95, 0.7, 0.5, 0.86,
  0.62, 0.98, 0.74, 0.52, 0.9, 0.66, 0.46, 0.8, 0.58, 0.92, 0.68, 0.5, 0.84, 0.6, 0.44, 0.76, 0.54,
  0.88, 0.62, 0.4, 0.7, 0.5, 0.34, 0.58, 0.42, 0.26, 0.44, 0.3, 0.18,
];

const FEATURES = [
  {
    icon: Clock,
    title: "24/7 Always On",
    body: "Never miss a call again",
    ring: "bg-[#DCFCE7] text-[#16A34A]",
  },
  {
    icon: Filter,
    title: "Qualifies Leads",
    body: "Asks the right questions",
    ring: "bg-[#EDE9FE] text-[#7C3AED]",
  },
  {
    icon: Calendar,
    title: "Books Appointments",
    body: "Straight to your calendar",
    ring: "bg-[#E0F2FE] text-[#0EA5E9]",
  },
  {
    icon: TrendingUp,
    title: "Grows Your Business",
    body: "More jobs. Less missed calls.",
    ring: "bg-[#FFEDD5] text-[#F97316]",
  },
] as const;

/* ------------------------------- the page -------------------------------- */

export default function LandingPage() {
  const navigate = useNavigate();
  const reset = useOnboardingStore((s) => s.reset);
  const skipWebsite = useOnboardingStore((s) => s.skipWebsite);
  const voiceId = useOnboardingStore((s) => s.voiceId);
  const setVoiceId = useOnboardingStore((s) => s.setVoiceId);

  const [howOpen, setHowOpen] = useState(false);

  /** Enter the guided funnel. `skipWebsite()` is what makes /onboarding
   *  reachable — it bounces visitors straight back here when neither a URL nor
   *  the skip flag is set. Business details are collected on step 2 instead. */
  function startDemo(source: string) {
    // Marketing conversion signal — a UNIQUE event (not GTM's generic
    // gtm.formSubmit) so it can be tracked on its own in GTM / GA4 / Google Ads.
    trackEvent("generate_ai_receptionist", { source });
    const keepVoice = voiceId;
    reset();
    setVoiceId(keepVoice);
    skipWebsite();
    navigate("/onboarding");
  }

  function scrollToFeatures() {
    document.getElementById("features")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-[#F8F9FB]">
      <div className="lp-page bg-[#F8F9FB] font-sans text-[#0F172A] antialiased">
        {/* ------------------------------ header ------------------------------ */}
        <header className="mx-auto w-full px-5 py-6 sm:px-8 lg:w-[1421px] lg:px-0 lg:py-[30px]">
          <div className="flex items-center justify-between gap-6">
            <Link to="/" className="flex shrink-0 items-center gap-2.5">
              <BrandLogo imgClassName="h-[38px] w-auto max-w-[230px] object-contain">
                <span className="grid size-[38px] place-items-center rounded-[12px] bg-[#F97316] shadow-[0_6px_16px_-6px_rgba(249,115,22,0.6)]">
                  <PhoneCall className="size-[19px] text-white" strokeWidth={2.2} />
                </span>
                <span className="text-[21px] font-bold tracking-[-0.02em] text-[#0F172A]">
                  tradiephone<span className="text-[#F97316]">.ai</span>
                </span>
              </BrandLogo>
            </Link>

            <nav className="hidden items-center gap-[52px] lg:flex">
              <button
                type="button"
                onClick={() => setHowOpen(true)}
                className="text-[15px] font-medium text-[#4B5563] transition-colors hover:text-[#0F172A]"
              >
                How it works
              </button>
              <button
                type="button"
                onClick={scrollToFeatures}
                className="text-[15px] font-medium text-[#4B5563] transition-colors hover:text-[#0F172A]"
              >
                Features
              </button>
              <Link
                to="/subscribe"
                className="text-[15px] font-medium text-[#4B5563] transition-colors hover:text-[#0F172A]"
              >
                Pricing
              </Link>
              <button
                type="button"
                onClick={() => startDemo("nav_demo")}
                className="text-[15px] font-medium text-[#4B5563] transition-colors hover:text-[#0F172A]"
              >
                Demo
              </button>
            </nav>

            <div className="flex shrink-0 items-center gap-[41px]">
              <span className="hidden h-[42px] items-center gap-2 rounded-full border border-[#E7E9EE] bg-white px-[18px] shadow-[0_1px_2px_rgba(15,23,42,0.04)] lg:inline-flex">
                <span className="lp-pulse size-[7px] rounded-full bg-[#22C55E]" />
                <span className="text-[13.5px] font-medium text-[#374151]">
                  AI Receptionist &bull; Live
                </span>
              </span>
              <Link
                to="/login"
                className="inline-flex h-[42px] items-center rounded-[10px] bg-[#F97316] px-[22px] text-[15px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(249,115,22,0.7)] transition-colors hover:bg-[#EA580C]"
              >
                Sign in
              </Link>
            </div>
          </div>
        </header>

        {/* ------------------------------- stage ------------------------------- */}
        <main className="mx-auto w-full px-5 pb-16 pt-10 sm:px-8 lg:w-[1445px] lg:px-0 lg:pb-[58px] lg:pt-[52px]">
          <div className="flex flex-col items-center gap-16 lg:grid lg:grid-cols-[466px_minmax(0,1fr)_483px] lg:items-start lg:gap-0">
            {/* =========================== THE OLD WAY =========================== */}
            <section className="relative order-2 w-full max-w-[466px] lg:order-1 lg:w-[466px]">
              <div className="mx-auto flex w-full max-w-[360px] flex-col items-center text-center lg:ml-[106px] lg:mr-0 lg:w-[360px] lg:max-w-none">
                <span className="lp-in" style={rise(80)}>
                  <Eyebrow tone="loss">The old way</Eyebrow>
                </span>
                <h2
                  className="lp-in mt-[19px] text-[30px] font-bold leading-[36px] tracking-[-0.025em] lg:whitespace-nowrap"
                  style={rise(140)}
                >
                  Missed call.
                  <br />
                  Missed opportunity.
                </h2>

                <PhoneShell className="lp-in mt-[28px]">
                  <div className="flex h-full flex-col items-center pt-[52px]">
                    <p className="text-[13px] leading-4 text-[#9CA3AF]">Incoming call</p>
                    <p className="mt-2.5 text-[20px] font-bold leading-[26px] tracking-[-0.02em] text-[#0F172A]">
                      New Customer
                    </p>
                    <p className="mt-2 text-[13px] leading-4 tracking-[0.01em] text-[#9CA3AF]">
                      0412 555 123
                    </p>

                    {/* The call button nobody pressed */}
                    <div className="relative mt-[72px] grid size-[70px] place-items-center">
                      <span
                        aria-hidden
                        className="absolute -inset-6 rounded-full bg-[#EF4444] opacity-[0.07]"
                      />
                      <span
                        aria-hidden
                        className="lp-ring absolute -inset-3 rounded-full border-2 border-[#EF4444] opacity-0"
                      />
                      <span className="relative grid size-[70px] place-items-center rounded-full bg-[#EF4444] shadow-[0_12px_28px_-12px_rgba(239,68,68,0.85)]">
                        <Phone
                          className="size-[26px] rotate-[135deg] text-white"
                          strokeWidth={2}
                          fill="currentColor"
                        />
                      </span>
                    </div>

                    <p className="mt-[56px] text-[13px] leading-4 text-[#9CA3AF]">No answer</p>
                  </div>
                </PhoneShell>
              </div>

              {/* Losses — pinned to the far left of the column on desktop */}
              <div className="mt-10 grid w-full grid-cols-1 gap-3 sm:grid-cols-3 lg:absolute lg:left-0 lg:top-[260px] lg:mt-0 lg:flex lg:w-[142px] lg:flex-col lg:gap-[22px]">
                {LOSS_CHIPS.map((c, i) => (
                  <OutcomeChip
                    key={c.label}
                    tone="loss"
                    icon={c.icon}
                    label={c.label}
                    delay={i * 900}
                  />
                ))}
              </div>

              {/* Handwritten margin note */}
              <div
                aria-hidden
                className="pointer-events-none absolute left-[63px] top-[596px] hidden lg:block"
              >
                <div className="relative">
                  <p className="lp-hand -rotate-2 text-[19px] leading-[23px] text-[#EE6A6D]">
                    They called
                    <br />
                    you... but
                    <br />
                    no one answered.
                  </p>
                  <svg
                    className="absolute -right-[46px] -top-[46px] h-[60px] w-[48px] text-[#EE6A6D]"
                    viewBox="0 0 48 60"
                    fill="none"
                  >
                    <path
                      d="M4 56C21 51 34 39 40 9"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <path
                      d="M32 15L40.5 6.5L43.5 17.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </div>
            </section>

            {/* ============================ THE PITCH ============================ */}
            <section className="order-1 flex w-full max-w-[496px] flex-col items-center text-center lg:order-2 lg:max-w-none">
              <span
                aria-hidden
                className="-mt-9 hidden h-[212px] w-px bg-gradient-to-b from-transparent to-[#DCE0E6] lg:block"
              />

              <h1
                className="lp-in text-[38px] font-bold leading-[1.14] tracking-[-0.035em] sm:text-[46px] lg:mt-[52px] lg:leading-[53px]"
                style={rise(0)}
              >
                Same call.
                <br />
                <span className="text-[#16A34A]">Better</span> outcome.
              </h1>

              <p
                className="lp-in mt-[27px] max-w-[400px] text-[17px] leading-[26px] text-[#6B7280]"
                style={rise(90)}
              >
                Our AI receptionist answers every call, qualifies leads, and books jobs &mdash; 24/7.
              </p>

              <span
                aria-hidden
                className="lp-in mt-[46px] grid size-[56px] place-items-center rounded-full bg-white shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_28px_-10px_rgba(15,23,42,0.22)]"
                style={rise(160)}
              >
                <Phone
                  className="size-[21px] text-[#F97316]"
                  strokeWidth={2.1}
                  fill="currentColor"
                />
              </span>

              <button
                type="button"
                onClick={() => startDemo("hero_cta")}
                className="lp-in group mt-[50px] inline-flex h-[51px] w-full max-w-[312px] items-center justify-center gap-2.5 rounded-[12px] bg-[#F97316] text-[16px] font-semibold text-white shadow-[0_14px_30px_-12px_rgba(249,115,22,0.65)] transition-colors hover:bg-[#EA580C]"
                style={rise(230)}
              >
                Try AI Receptionist
                <ArrowRight className="size-[17px] transition-transform group-hover:translate-x-0.5" />
              </button>

              <button
                type="button"
                onClick={() => setHowOpen(true)}
                className="lp-in mt-[28px] inline-flex items-center gap-2 text-[15px] font-medium text-[#1F2937] transition-colors hover:text-[#F97316]"
                style={rise(300)}
              >
                <span className="grid size-[15px] place-items-center rounded-full bg-[#F97316]">
                  <Play className="size-[7px] translate-x-[0.5px] fill-white text-white" />
                </span>
                Watch 60 sec demo
              </button>
            </section>

            {/* ============================ THE AI WAY ============================ */}
            <section className="relative order-3 w-full max-w-[483px] lg:w-[483px]">
              <div className="mx-auto flex w-full max-w-[360px] flex-col items-center text-center lg:mx-0 lg:w-[360px] lg:max-w-none">
                <span className="lp-in" style={rise(80)}>
                  <Eyebrow tone="win">The AI way</Eyebrow>
                </span>
                <h2
                  className="lp-in mt-[19px] text-[30px] font-bold leading-[36px] tracking-[-0.025em] lg:whitespace-nowrap"
                  style={rise(140)}
                >
                  Every call answered.
                  <br />
                  Every opportunity captured.
                </h2>

                <PhoneShell className="lp-in mt-[28px]">
                  <div className="flex h-full flex-col px-[27px] pt-[45px] text-left">
                    {/* live-call header */}
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-[#EAFBF1]">
                        <Sparkles className="size-[16px] text-[#22A45D]" strokeWidth={2} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[14.5px] font-bold leading-[18px] tracking-[-0.01em] text-[#0F172A]">
                          AI Receptionist
                        </span>
                        <span className="mt-[3px] flex items-center gap-1.5">
                          <span className="lp-pulse size-[6px] rounded-full bg-[#22C55E]" />
                          <span className="text-[11.5px] leading-[13px] text-[#9CA3AF]">
                            Live call &bull; 00:32
                          </span>
                        </span>
                      </span>
                    </div>

                    {/* waveform */}
                    <div className="mt-[25px] flex h-[50px] w-[166px] items-center gap-[1.6px] self-center">
                      {WAVE.map((h, i) => (
                        <span
                          key={i}
                          className="lp-bar w-[2px] rounded-full bg-[#22C55E]"
                          style={
                            {
                              height: `${Math.round(h * 100)}%`,
                              opacity: 0.55 + h * 0.45,
                              "--lp-delay": `${(i % 7) * 110}ms`,
                            } as CSSProperties
                          }
                        />
                      ))}
                    </div>

                    {/* transcript — avatars hang off the bezel */}
                    <div className="relative -mx-[27px] mt-[25px] px-[2px]">
                      <div className="relative">
                        <span className="absolute -left-[38px] top-0">
                          <ChatAvatar kind="caller" />
                        </span>
                        <p className="w-[172px] rounded-2xl border border-[#EFF1F4] bg-white px-3 py-2.5 text-[10.5px] leading-[15px] tracking-[-0.005em] text-[#3C4657] shadow-[0_6px_18px_-10px_rgba(15,23,42,0.25)]">
                          Hi! How can I help you today?
                        </p>
                      </div>

                      <div className="relative mt-[28px]">
                        <span className="absolute -right-[38px] top-1/2 -translate-y-1/2">
                          <ChatAvatar kind="caller" />
                        </span>
                        <p className="ml-auto w-[152px] rounded-2xl border border-[#D6F5E3] bg-[#EAFBF1] px-3 py-2.5 text-[10.5px] leading-[15px] tracking-[-0.005em] text-[#28323F] shadow-[0_6px_18px_-12px_rgba(15,23,42,0.2)]">
                          I need a quote for a bathroom renovation.
                        </p>
                      </div>

                      <div className="relative mt-[28px]">
                        <span className="absolute -left-[38px] top-0">
                          <ChatAvatar kind="ai" />
                        </span>
                        <p className="w-[178px] rounded-2xl border border-[#EFF1F4] bg-white px-3 py-2.5 text-[10.5px] leading-[15px] tracking-[-0.005em] text-[#3C4657] shadow-[0_6px_18px_-10px_rgba(15,23,42,0.25)]">
                          Sure! Can you tell me your suburb so I can check availability?
                        </p>
                      </div>
                    </div>
                  </div>
                </PhoneShell>
              </div>

              {/* Wins — pinned to the far right of the column on desktop */}
              <div className="mt-10 grid w-full grid-cols-1 gap-3 sm:grid-cols-3 lg:absolute lg:right-0 lg:top-[268px] lg:mt-0 lg:flex lg:w-[150px] lg:flex-col lg:gap-[22px]">
                {WIN_CHIPS.map((c, i) => (
                  <OutcomeChip
                    key={c.label}
                    tone="win"
                    icon={c.icon}
                    label={c.label}
                    delay={i * 900 + 450}
                  />
                ))}
              </div>

              {/* Handwritten margin note */}
              <div
                aria-hidden
                className="pointer-events-none absolute right-[81px] top-[616px] hidden lg:block"
              >
                <div className="relative">
                  <p className="lp-hand rotate-2 text-right text-[19px] leading-[23px] text-[#3FBF74]">
                    They called
                    <br />
                    you... and got
                    <br />a great experience.
                  </p>
                  <svg
                    className="absolute -left-[50px] -top-[42px] h-[60px] w-[48px] text-[#3FBF74]"
                    viewBox="0 0 48 60"
                    fill="none"
                  >
                    <path
                      d="M44 56C27 51 14 39 8 9"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <path
                      d="M16 15L7.5 6.5L4.5 17.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </div>
            </section>
          </div>

          {/* ---------------------------- feature bar ---------------------------- */}
          <div
            id="features"
            className="lp-in mx-auto mt-16 w-full max-w-[1181px] rounded-[18px] border border-[#EAECF0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_18px_44px_-26px_rgba(15,23,42,0.22)] lg:mt-[60px] lg:w-[1181px]"
            style={rise(380)}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:h-[88px] lg:grid-cols-4">
              {FEATURES.map(({ icon: Icon, title, body, ring }, i) => (
                <div
                  key={title}
                  className="relative flex items-center gap-[19px] px-6 py-5 lg:px-0 lg:py-0 lg:pl-[41px]"
                >
                  {i > 0 && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 hidden h-[44px] w-px -translate-y-1/2 bg-[#EAECF0] lg:block"
                    />
                  )}
                  <span
                    className={cn("grid size-[34px] shrink-0 place-items-center rounded-full", ring)}
                  >
                    <Icon className="size-[17px]" strokeWidth={2} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14.5px] font-semibold leading-[18px] tracking-[-0.01em] text-[#0F172A]">
                      {title}
                    </span>
                    <span className="mt-[3px] block text-[12.5px] leading-[16px] text-[#8A93A2]">
                      {body}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>

      <HowItWorksDialog open={howOpen} onOpenChange={setHowOpen} />
    </div>
  );
}
