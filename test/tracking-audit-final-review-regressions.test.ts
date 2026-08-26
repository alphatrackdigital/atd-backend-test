import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vercelHandler from "../api/leads";
import netlifyHandler from "../netlify/functions/leads.mjs";
import {
  normalizeTrackingAuditApplication as normalizeVercelAudit,
} from "../api/_lib/trackingAuditContract";
import {
  normalizeTrackingAuditApplication as normalizeNetlifyAudit,
} from "../netlify/functions/lib/tracking-audit-contract.mjs";
import { resetIdempotencyForTests as resetVercelIdempotency } from "../api/_lib/idempotency";
import { resetIdempotencyForTests as resetNetlifyIdempotency } from "../netlify/functions/lib/idempotency.mjs";

const canonicalAudit = (email: string, metaEventId = "browser-event-original") => ({
  source: "tracking_audit_offer",
  firstName: "Ama",
  lastName: "Mensah",
  email,
  company: "Example Co",
  websiteUrl: "https://example.com",
  industry: "professional_services",
  role: "founder_ceo",
  decisionInfluence: "final_decision_maker",
  monthlyAdSpendBand: "6000_14999",
  adPlatforms: ["meta_ads", "google_ads"],
  trackingMaturity: "disconnected",
  primaryConversionType: "lead_form",
  measurementProblem: "conflicting_numbers",
  urgency: "before_scaling",
  metaEventId,
});

const buildVercelRequest = (body: Record<string, unknown>, ip: string) => ({
  method: "POST",
  body,
  headers: {
    origin: "https://alphatrack.digital",
    "user-agent": "vitest-final-review",
    "x-forwarded-for": ip,
  },
});

const buildVercelResponse = () => {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      payload = value;
    },
    setHeader() {},
  };
  return { response, result: () => ({ statusCode, payload }) };
};

const buildNetlifyRequest = (body: Record<string, unknown>, ip: string) =>
  new Request("https://alphatrack.digital/api/leads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vitest-final-review",
      "x-nf-client-connection-ip": ip,
    },
    body: JSON.stringify(body),
  });

const installMetaRetryFetch = () => {
  const metaBodies: Array<Record<string, unknown>> = [];
  let metaAttempts = 0;

  const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    const method = String(init.method || "GET").toUpperCase();

    if (target.startsWith("https://api.brevo.com/v3/contacts/") && method === "GET") {
      return new Response("", { status: 404 });
    }
    if (target === "https://api.brevo.com/v3/contacts" && method === "POST") {
      return new Response(JSON.stringify({ id: 456 }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/crm/tasks") {
      return new Response(JSON.stringify({ id: "task-1" }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/smtp/email") {
      return new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 });
    }
    if (target.includes("graph.facebook.com")) {
      metaAttempts += 1;
      metaBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (metaAttempts === 1) return new Response("", { status: 503 });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { metaBodies, getMetaAttempts: () => metaAttempts };
};

const metaEventIds = (bodies: Array<Record<string, unknown>>) =>
  bodies.map((body) => {
    const data = body.data as Array<Record<string, unknown>>;
    return data[0]?.event_id;
  });

const normalizers = [
  ["Vercel", normalizeVercelAudit],
  ["Netlify", normalizeNetlifyAudit],
] as const;

describe("Tracking Audit final review regressions", () => {
  beforeEach(() => {
    process.env.VITEST = "true";
    resetVercelIdempotency();
    resetNetlifyIdempotency();
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_AUDIT_LIST_ID = "11";
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DATABASE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of [
      "VITEST",
      "BREVO_API_KEY",
      "BREVO_AUDIT_LIST_ID",
      "META_PIXEL_ID",
      "META_CAPI_ACCESS_TOKEN",
      "MONGODB_URI",
      "MONGODB_DATABASE",
    ]) delete process.env[name];
  });

  for (const [runtime, normalizeAudit] of normalizers) {
    it(`${runtime} rejects partial canonical payloads instead of downgrading them to legacy`, () => {
      const payload = {
        ...canonicalAudit(`${runtime.toLowerCase()}-partial@example.com`),
        monthlyAdSpendBand: "",
        monthlyAdSpend: "6000_14999",
        urgency: "",
      };
      const result = normalizeAudit(payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContain("urgency");
    });

    it(`${runtime} rejects an unknown canonical channel even when another channel is valid`, () => {
      const payload = {
        ...canonicalAudit(`${runtime.toLowerCase()}-channel@example.com`),
        adPlatforms: ["meta_ads", "facebook_ads"],
      };
      const result = normalizeAudit(payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContain("adPlatforms");
    });

    it(`${runtime} still accepts genuinely legacy channel labels`, () => {
      const result = normalizeAudit({
        source: "tracking_audit_offer",
        websiteUrl: "https://legacy.example.com",
        monthlyAdSpend: "$1k - $5k / mo",
        adPlatforms: "Google Ads, Meta Ads",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mode).toBe("legacy");
      expect(result.value.adPlatforms).toEqual(["google_ads", "meta_ads"]);
    });
  }

  it("Vercel reuses the original Meta event ID when a replay-safe CAPI retry carries a different ID", async () => {
    const provider = installMetaRetryFetch();
    const original = canonicalAudit("vercel-meta-stable@example.com", "vercel-browser-event-original");

    const first = buildVercelResponse();
    await vercelHandler(buildVercelRequest(original, "127.20.0.1"), first.response);
    expect(first.result()).toMatchObject({
      statusCode: 200,
      payload: { ok: true, duplicate: false, metaEventId: "vercel-browser-event-original" },
    });

    const retry = buildVercelResponse();
    await vercelHandler(
      buildVercelRequest({ ...original, metaEventId: "vercel-browser-event-changed" }, "127.20.0.2"),
      retry.response,
    );
    expect(retry.result()).toMatchObject({
      statusCode: 200,
      payload: { ok: true, duplicate: true, metaEventId: "vercel-browser-event-original" },
    });

    expect(provider.getMetaAttempts()).toBe(2);
    expect(metaEventIds(provider.metaBodies)).toEqual([
      "vercel-browser-event-original",
      "vercel-browser-event-original",
    ]);
  });

  it("Netlify reuses the original Meta event ID when a replay-safe CAPI retry carries a different ID", async () => {
    const provider = installMetaRetryFetch();
    const original = canonicalAudit("netlify-meta-stable@example.com", "netlify-browser-event-original");

    const first = await netlifyHandler(buildNetlifyRequest(original, "127.21.0.1"));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      metaEventId: "netlify-browser-event-original",
    });

    const retry = await netlifyHandler(
      buildNetlifyRequest({ ...original, metaEventId: "netlify-browser-event-changed" }, "127.21.0.2"),
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      metaEventId: "netlify-browser-event-original",
    });

    expect(provider.getMetaAttempts()).toBe(2);
    expect(metaEventIds(provider.metaBodies)).toEqual([
      "netlify-browser-event-original",
      "netlify-browser-event-original",
    ]);
  });
});