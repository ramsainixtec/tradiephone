import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { loadSettings, getEffective } from "../src/services/settings.js";

/* ------------------------------------------------------------------ *
 *  READ-ONLY: dump the RAW message list Vapi recorded for a call.
 *
 *  Our stored transcript is a rendering. This is the source, and it
 *  answers the one thing a transcript cannot: when the agent "said
 *  Goodbye", did the MODEL generate that word, or did the platform end
 *  the call and the transcript just show it that way?
 *
 *  Usage: npx tsx scripts/_callMessages.ts <account-email> [howMany]
 * ------------------------------------------------------------------ */

const prisma = new PrismaClient();
const EMAIL = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 1);

async function main() {
  await loadSettings();
  const key = getEffective("vapi.apiKey");
  if (!EMAIL) return console.log("Pass an account email.");

  const calls = await prisma.callLog.findMany({
    where: { conversion: { user: { email: EMAIL } } },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
    select: { analysis: true, transcript: true, createdAt: true, durationSec: true },
  });
  if (!calls.length) return console.log(`No calls recorded for ${EMAIL}.`);

  for (const c of calls) {
    const vapiCallId = (c.analysis as { vapiCallId?: unknown } | null)?.vapiCallId;
    console.log(`\n================ ${c.createdAt.toISOString()} (${c.durationSec}s)`);

    // What WE stored — the last line the customer sees in the inbox.
    const t = Array.isArray(c.transcript) ? (c.transcript as { role?: string; text?: string }[]) : [];
    const lastStored = [...t].reverse().find((l) => l.role !== "caller" && l.role !== "user");
    console.log(`  our transcript, last agent line: ${JSON.stringify(lastStored?.text ?? "(none)")}`);

    if (typeof vapiCallId !== "string" || !vapiCallId) {
      console.log("  no vapiCallId stored — can't fetch the raw record");
      continue;
    }
    const res = await fetch(`https://api.vapi.ai/call/${vapiCallId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.log(`  Vapi fetch failed HTTP ${res.status}`);
      continue;
    }
    const call = (await res.json()) as Record<string, any>;
    console.log(`  endedReason: ${call.endedReason ?? "(none)"}`);

    const msgs: any[] = call.messages ?? call.artifact?.messages ?? [];
    const botTurns = msgs.filter((m) => m.role === "bot" || m.role === "assistant");
    const last = botTurns[botTurns.length - 1];
    console.log(`  RAW last model output: ${JSON.stringify(last?.message ?? last?.content ?? "(none)")}`);

    const tools = msgs.flatMap((m) =>
      (m.toolCalls ?? []).map((x: any) => x.function?.name ?? x.name).filter(Boolean),
    );
    console.log(`  tool calls: ${tools.length ? tools.join(", ") : "(none)"}`);

    console.log("  --- last 6 raw turns ---");
    for (const m of msgs.slice(-6)) {
      const text = m.message ?? m.content ?? "";
      console.log(`    [${m.role}] ${String(text).slice(0, 160)}`);
    }
  }
}

main().finally(() => prisma.$disconnect());
