import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { auditLifecycleAttributes, normalizeTrackingAuditApplication } from "../api/_lib/trackingAuditContract";
import { resetIdempotencyForTests } from "../netlify/functions/lib/idempotency.mjs";

const { saveLeadContactMock } = vi.hoisted(() => ({
  saveLeadContactMock: vi.fn(),
}));

vi.mock("../netlify/functions/lib/contact-persistence.mjs", () => ({
  saveLeadContact: saveLeadContactMock,
}));

import handler from "../netlify/functions/leads.mjs";

const canonicalAudit = {
  source: "tracking_audit_offer",
  firstName: "Ama",
  lastName: "Mensah",
  email: "release-blocker@example.com",
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
  metaEventId: "tracking-audit-release-blocker-event",
};

const legacyAudit = {
  source: "tracking_audit_offer",
  firstName: "Grace",
  lastName: "Hopper",
  email: "release-legacy@example.com",
  websiteUrl: "https://legacy.example.com",
  monthlyAdSpend: "$1k - $5k / mo",
  adPlatforms: "Google Ads, Meta Ads",
};

const buildRequest = (body: Record<string, unknown>) =>
  new Request("https://alphatrack.digital/api/leads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vitest-release-blockers",
      "x-nf-client-connection-ip": "127.3.0.8",
    },
    body: JSON.stringify(body),
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const installProviderFetch = () => {
  const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    const method = String(init.method || "GET").toUpperCase();

    if (target.startsWith("https://api.brevo.com/v3/contacts/") && method === "GET") {
      return new Response("", { status: 404 });
    }
    if (target === "https://api.brevo.com/v3/contacts" && method === "POST") {
      await sleep(10);
      return new Response(JSON.stringify({ id: 991 }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/crm/tasks") {
      await sleep(10);
      return new Response(JSON.stringify({ id: "task-991" }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/smtp/email") {
      await sleep(10);
      return new Response(JSON.stringify({ messageId: "message-991" }), { status: 201 });
    }
    if (target.includes("graph.facebook.com")) {
      await sleep(10);
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const callsFor = (fetchMock: ReturnType<typeof vi.fn>, needle: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(needle));

const smtpBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  callsFor(fetchMock, "/smtp/email").map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe("Tracking Audit release blocker regressions", () => {
  beforeEach(() => {
    process.env.VITEST = "true";
    resetIdempotencyForTests();
    saveLeadContactMock.mockReset();
    saveLeadContactMock.mockResolvedValue(true);
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_AUDIT_LIST_ID = "11";
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    process.env.META_CAPI_TEST_EVENT_CODE = "TEST_RELEASE_BLOCKERS";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of [
      "VITEST",
      "BREVO_API_KEY",
      "BREVO_AUDIT_LIST_ID",
      "META_PIXEL_ID",
      "META_CAPI_ACCESS_TOKEN",
      "META_CAPI_TEST_EVENT_CODE",
      "MONGODB_URI",
      "MONGODB_DATABASE",
    ]) delete process.env[name];
  });

  it("clears fields that belong to the previous audit mode", () => {
    const canonical = normalizeTrackingAuditApplication(canonicalAudit);
    const legacy = normalizeTrackingAuditApplication(legacyAudit);
    expect(canonical.ok).toBe(true);
    expect(legacy.ok).toBe(true);
    if (!canonical.ok || !legacy.ok) return;

    const canonicalAttrs = auditLifecycleAttributes(canonical.value, "2026-08-26T16:00:00.000Z");
    expect(canonicalAttrs).toMatchObject({
      AUDIT_STATUS: "Applied",
      AUDIT_LEGACY_AD_SPEND: "",
      AUDIT_REVIEW_OUTCOME: "",
      AUDIT_REVIEW_RATIONALE: "",
    });

    const legacyAttrs = auditLifecycleAttributes(legacy.value, "2026-08-26T16:00:00.000Z");
    expect(legacyAttrs).toMatchObject({
      AUDIT_STATUS: "Manual Review",
      AUDIT_INDUSTRY: "",
      AUDIT_ROLE: "",
      AUDIT_DECISION_INFLUENCE: "",
      AUDIT_AD_SPEND_BAND: "",
      AUDIT_TRACKING_MATURITY: "",
      AUDIT_PRIMARY_CONVERSION: "",
      AUDIT_MEASUREMENT_PROBLEM: "",
      AUDIT_URGENCY: "",
    });
  });

  it("claims side effects atomically when identical applications overlap", async () => {
    const fetchMock = installProviderFetch();

    const [first, second] = await Promise.all([
      handler(buildRequest(canonicalAudit)),
      handler(buildRequest(canonicalAudit)),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(saveLeadContactMock).toHaveBeenCalledTimes(1);
    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "New tracking audit application")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "We received your Tracking Audit application")).toHaveLength(1);
    expect(callsFor(fetchMock, "graph.facebook.com")).toHaveLength(1);
  });

  it("retries Mongo persistence after a transient failure without repeating completed side effects", async () => {
    const fetchMock = installProviderFetch();
    saveLeadContactMock
      .mockRejectedValueOnce(new Error("temporary Mongo outage"))
      .mockResolvedValueOnce(true);

    const first = await handler(buildRequest(canonicalAudit));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ ok: true, duplicate: false });

    const second = await handler(buildRequest(canonicalAudit));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    expect(saveLeadContactMock).toHaveBeenCalledTimes(2);
    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "New tracking audit application")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "We received your Tracking Audit application")).toHaveLength(1);
    expect(callsFor(fetchMock, "graph.facebook.com")).toHaveLength(1);
  });
});
