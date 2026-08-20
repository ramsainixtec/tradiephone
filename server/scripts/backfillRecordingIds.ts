import "dotenv/config";
import { prisma } from "../src/prisma.js";
import { loadSettings, integrationsStatus, getEffective } from "../src/services/settings.js";

/* ------------------------------------------------------------------ *
 *  One-off backfill: store each call's Vapi call id on its analysis so
 *  the recording proxy can pull audio from Vapi's authenticated
 *  endpoint. Needed for calls logged before we captured the call id —
 *  their storage.vapi.ai URLs are no longer publicly fetchable.
 *
 *  Matches our stored recordingUrl against Vapi's call list to recover
 *  the id. Run with:  npm run backfill-recordings   (add --dry-run to
 *  preview without writing).
 * ------------------------------------------------------------------ */

const VAPI_BASE = "https://api.vapi.ai";
const DRY_RUN = process.argv.includes("--dry-run");
const PAGE = 1000; // Vapi's max page size
const MAX_PAGES = 200; // safety cap (up to 200k calls)

await loadSettings(); // hydrate the Vapi API key from DB/env

if (!integrationsStatus().vapi) {
  console.error("Vapi is not configured — set the API key in Admin → Settings or server/.env.");
  process.exit(1);
}
const apiKey = getEffective("vapi.apiKey").trim();

/** All recording URLs Vapi exposes on a call object, so we can match whichever
 *  variant we happened to store. */
function recordingUrlsOf(call: Record<string, any>): string[] {
  const artifact = (call.artifact ?? {}) as Record<string, any>;
  const recording = (artifact.recording ?? {}) as Record<string, any>;
  const mono = (recording.mono ?? {}) as Record<string, any>;
  return [
    call.recordingUrl,
    artifact.recordingUrl,
    artifact.stereoRecordingUrl,
    recording.combinedUrl,
    recording.stereoUrl,
    mono.combinedUrl,
  ].filter((u): u is string => typeof u === "string" && u.length > 0);
}

// 1. Pull the whole call list from Vapi, building recordingUrl -> callId.
console.log("Fetching call list from Vapi…");
const urlToCallId = new Map<string, string>();
let createdAtLt: string | undefined;
let fetched = 0;
for (let page = 0; page < MAX_PAGES; page++) {
  const qs = new URLSearchParams({ limit: String(PAGE) });
  if (createdAtLt) qs.set("createdAtLt", createdAtLt);
  const res = await fetch(`${VAPI_BASE}/call?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error(`Vapi list failed (HTTP ${res.status}) — stopping with ${fetched} calls fetched.`);
    break;
  }
  const calls = (await res.json()) as Record<string, any>[];
  if (!calls.length) break;
  fetched += calls.length;
  for (const c of calls) {
    if (typeof c.id !== "string") continue;
    for (const u of recordingUrlsOf(c)) if (!urlToCallId.has(u)) urlToCallId.set(u, c.id);
  }
  // Vapi returns newest-first; page down by the oldest createdAt in the batch.
  const oldest = calls[calls.length - 1]?.createdAt;
  if (typeof oldest !== "string" || oldest === createdAtLt) break;
  createdAtLt = oldest;
  if (calls.length < PAGE) break;
}
console.log(`Indexed ${urlToCallId.size} recording URL(s) across ${fetched} Vapi call(s).`);

// 2. Find call logs that still need a stored id (have a recordingUrl, but no
//    vapiCallId on analysis).
const candidates = await prisma.callLog.findMany({
  where: { recordingUrl: { not: null } },
  select: { id: true, recordingUrl: true, analysis: true },
});
const needing = candidates.filter(
  (c) => !(c.analysis as { vapiCallId?: unknown } | null)?.vapiCallId,
);
console.log(`${needing.length} call log(s) missing a stored Vapi call id.`);

// 3. Match and backfill.
let updated = 0;
let unmatched = 0;
for (const c of needing) {
  const vapiCallId = c.recordingUrl ? urlToCallId.get(c.recordingUrl) : undefined;
  if (!vapiCallId) {
    unmatched++;
    continue;
  }
  if (DRY_RUN) {
    console.log(`- ${c.id}: would set vapiCallId=${vapiCallId}`);
    updated++;
    continue;
  }
  const analysis = (c.analysis && typeof c.analysis === "object" ? c.analysis : {}) as Record<
    string,
    unknown
  >;
  await prisma.callLog.update({
    where: { id: c.id },
    data: { analysis: { ...analysis, vapiCallId } as object },
  });
  updated++;
}

console.log(
  `Done${DRY_RUN ? " (dry run)" : ""}. ${updated} backfilled, ${unmatched} unmatched ` +
    `(no longer on Vapi / retention expired).`,
);
process.exit(0);
