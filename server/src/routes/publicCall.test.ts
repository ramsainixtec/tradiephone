import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

/* ------------------------------------------------------------------ *
 *  Public conversation page (/c/:publicId) — HTTP-level coverage.
 *  Boots the real router against a stubbed Prisma so we observe the
 *  actual rendered HTML, status codes and expiry handling end-to-end.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({ findUnique: vi.fn() }));

// Mocking a module replaces ALL of its exports, so every export something in
// this route's import graph reads has to be present — a partial mock made the
// whole suite fail to load (and silently run zero tests).
vi.mock("../env.js", () => ({
  publicApiBaseUrl: "https://api.test",
  appBaseUrl: "https://app.test",
  shareLinkBaseUrl: "https://api.test",
  corsOrigins: ["https://app.test"],
  env: {
    // lib/crypto.ts derives its AES key from this at import time.
    JWT_SECRET: "test-secret-for-public-call-suite",
    APP_URL: "https://app.test",
    PUBLIC_API_URL: "https://api.test",
    VAPI_SERVER_URL: "https://api.test",
    SHARE_LINK_BASE_URL: "",
    CORS_ORIGIN: "https://app.test",
  },
}));
vi.mock("../prisma.js", () => ({ prisma: { callLog: { findUnique: h.findUnique } } }));
vi.mock("../services/emailTemplates.js", () => ({
  emailGlobals: () => ({ app_name: "Tradie Phone", support_email: "support@tradiephone.ai" }),
}));

const { default: router } = await import("./publicCall.routes.js");

let server: Server;
let base: string;

beforeEach(() => {
  vi.clearAllMocks();
});

// One shared app/port for the suite.
const app = express();
app.use("/c", router);
await new Promise<void>((resolve) => {
  server = app.listen(0, () => {
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    resolve();
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sampleCall = {
  id: "call_1",
  callerName: "Jane Doe",
  callerNumber: "+61400111222",
  purpose: "Booking a haircut",
  summary: "Caller wants a Saturday appointment.",
  durationSec: 95,
  recordingUrl: "https://storage.vapi.ai/rec.wav",
  transcript: [
    { role: "assistant", text: "Hi, how can I help?" },
    { role: "user", text: "I'd like to book a haircut." },
  ],
  createdAt: new Date("2026-07-14T09:00:00Z"),
  shareExpiresAt: new Date("2026-08-14T09:00:00Z"),
};

describe("GET /c/:publicId", () => {
  it("renders the conversation with caller, purpose, recording and transcript", async () => {
    h.findUnique.mockResolvedValue(sampleCall);
    const res = await fetch(`${base}/c/Xa7bK2p9`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Booking a haircut");
    expect(html).toContain("Caller wants a Saturday appointment.");
    // Recording is proxied through our own domain, never storage.vapi.ai — and
    // via a SIGNED token, never the raw call id (which isn't a secret).
    expect(html).toMatch(/https:\/\/api\.test\/api\/calls\/recording-file\/eyJ[\w.-]+/);
    expect(html).not.toContain("/recording-file/call_1");
    expect(html).not.toContain("storage.vapi.ai");
    // Transcript turns are rendered and labelled.
    expect(html).toContain("I&#39;d like to book a haircut.");
    expect(html).toContain("Agent");
    // Never indexed.
    expect(html).toContain("noindex");
  });

  it("returns 410 with an expiry notice for a link past its validity", async () => {
    h.findUnique.mockResolvedValue({ ...sampleCall, shareExpiresAt: new Date("2000-01-01T00:00:00Z") });
    const res = await fetch(`${base}/c/expired1`);
    const html = await res.text();
    expect(res.status).toBe(410);
    expect(html).toContain("Link expired");
    expect(html).not.toContain("Jane Doe");
  });

  it("returns 404 for an unknown slug", async () => {
    h.findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/c/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Conversation not found");
  });

  it("escapes HTML in stored fields (no injection)", async () => {
    h.findUnique.mockResolvedValue({
      ...sampleCall,
      callerName: "<script>alert(1)</script>",
      recordingUrl: null,
      transcript: [],
    });
    const res = await fetch(`${base}/c/xss`);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a never-expiring link (shareExpiresAt null)", async () => {
    h.findUnique.mockResolvedValue({ ...sampleCall, shareExpiresAt: null });
    const res = await fetch(`${base}/c/forever`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Jane Doe");
  });
});
