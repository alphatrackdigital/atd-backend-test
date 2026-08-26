import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vercelHandler from "../api/leads";
import netlifyHandler from "../netlify/functions/leads.mjs";
import {
  buildLeadDedupeKey as buildVercelDedupeKey,
  resetIdempotencyForTests as resetVercelIdempotency,
} from "../api/_lib/idempotency";
import {
  buildLeadDedupeKey as buildNetlifyDedupeKey,
  resetIdempotencyForTests as resetNetlifyIdempotency,
} from "../netlify/functions/lib/idempotency.mjs";

const canonicalAudit = (email: string) => ({
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
});

const buildVercelRequest = (body: Record<string, unknown>, ip: string) => ({
  method: "POST",
  body,
  headers: {
    origin: "https://alphatrack.digital",
    "user-agent": "vitest-idempotency-safety",
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
      "user-agent": "vitest-idempotency-safety",
      "x-nf-client-connection-ip": ip,
    },
    body: JSON.stringify(body),
  });

type FailureMode = 408 | 503 | "network";

const installProviderFetch = (mode: FailureMode) => {
  let receiptAttempts = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    const method = String(init.method || "GET").toUpperCase();

    if (target.startsWith("https://api.brevo.com/v3/contacts/") && method === "GET") {
      return new Response("", { status: 404 });
    }
    if (target === "https://api.brevo.com/v3/contacts" && method === "POST") {
      return new Response(JSON.stringify({ id: 456 }), { status: 201 });
    }
    if (target.includes("/contacts/lists/") && method === "POST") {
      return new Response(JSON.stringify({ contacts: { success: ["ok"], failure: [] } }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/crm/tasks") {
      return new Response(JSON.stringify({ id: "task-1" }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/smtp/email") {
      const body = JSON.parse(String(init.body));
      if (body.subject === "We received your Tracking Audit application") {
        receiptAttempts += 1;
        if (receiptAttempts === 1) {
          if (mode === "network") throw new Error("simulated socket reset after provider write");
          return new Response("", { status: mode });
        }
      }
      return new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { getReceiptAttempts: () => receiptAttempts };
};

describe("Tracking Audit idempotency safety", () => {
  beforeEach(() => {
    process.env.VITEST = "true";
    resetVercelIdempotency();
    resetNetlifyIdempotency();
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_AUDIT_LIST_ID = "11";
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DATABASE;
    delete process.env.META_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of [
      "VITEST",
      "BREVO_API_KEY",
      "BREVO_AUDIT_LIST_ID",
      "MONGODB_URI",
      "MONGODB_DATABASE",
      "META_PIXEL_ID",
      "META_CAPI_ACCESS_TOKEN",
    ]) delete process.env[name];
  });

  it("deduplicates semantic channel labels, codes, order, and attribution noise in both runtimes", () => {
    const base = canonicalAudit("channels@example.com");
    const legacyLabels = { ...base, adPlatforms: ["Google Ads", "Meta Ads"] };
    const reorderedCodes = { ...base, adPlatforms: ["google_ads", "meta_ads"] };
    const attributionNoise = {
      ...base,
      attribution: { utmSource: "meta", utmCampaign: "different-campaign", fbclid: "different-click" },
    };

    expect(buildVercelDedupeKey(base)).toBe(buildVercelDedupeKey(legacyLabels));
    expect(buildVercelDedupeKey(base)).toBe(buildVercelDedupeKey(reorderedCodes));
    expect(buildVercelDedupeKey(base)).toBe(buildVercelDedupeKey(attributionNoise));

    expect(buildNetlifyDedupeKey(base)).toBe(buildNetlifyDedupeKey(legacyLabels));
    expect(buildNetlifyDedupeKey(base)).toBe(buildNetlifyDedupeKey(reorderedCodes));
    expect(buildNetlifyDedupeKey(base)).toBe(buildNetlifyDedupeKey(attributionNoise));
  });

  for (const mode of [408, 503, "network"] as const) {
    it(`does not replay a Vercel applicant receipt after an ambiguous ${mode} outcome`, async () => {
      resetVercelIdempotency();
      resetNetlifyIdempotency();
      const provider = installProviderFetch(mode);
      const audit = canonicalAudit(`vercel-${mode}@example.com`);

      const first = buildVercelResponse();
      await vercelHandler(buildVercelRequest(audit, `127.10.0.${mode === "network" ? 30 : mode === 408 ? 8 : 9}`), first.response);
      expect(first.result()).toMatchObject({ statusCode: 200, payload: { ok: true, duplicate: false } });

      const duplicate = buildVercelResponse();
      await vercelHandler(buildVercelRequest(audit, `127.10.0.${mode === "network" ? 30 : mode === 408 ? 8 : 9}`), duplicate.response);
      expect(duplicate.result()).toMatchObject({ statusCode: 200, payload: { ok: true, duplicate: true } });
      expect(provider.getReceiptAttempts()).toBe(1);
    });

    it(`does not replay a Netlify applicant receipt after an ambiguous ${mode} outcome`, async () => {
      resetVercelIdempotency();
      resetNetlifyIdempotency();
      const provider = installProviderFetch(mode);
      const audit = canonicalAudit(`netlify-${mode}@example.com`);
      const ip = `127.11.0.${mode === "network" ? 30 : mode === 408 ? 8 : 9}`;

      const first = await netlifyHandler(buildNetlifyRequest(audit, ip));
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({ ok: true, duplicate: false });

      const duplicate = await netlifyHandler(buildNetlifyRequest(audit, ip));
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });
      expect(provider.getReceiptAttempts()).toBe(1);
    });
  }
});