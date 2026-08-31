import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/leads";
import { resetIdempotencyForTests } from "../api/_lib/idempotency";

const buildRequest = (body: Record<string, unknown>) => ({
  method: "POST",
  body,
  headers: {
    origin: "https://alphatrack.digital",
    "user-agent": "vitest",
    "x-forwarded-for": `127.2.0.${Math.floor(Math.random() * 200) + 1}`,
  },
});

const buildResponse = () => {
  let statusCode = 200;
  let payload: unknown;
  const headers = new Map<string, string>();
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      payload = value;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
  };
  return { response, result: () => ({ statusCode, payload, headers }) };
};

const canonicalAudit = {
  source: "tracking_audit_offer",
  firstName: "Ama",
  lastName: "Mensah",
  email: "ama@example.com",
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
  metaEventId: "audit-event-1",
  attribution: {
    utmSource: "meta",
    utmCampaign: "atd_tracking_audit_gh_accra_p1",
    utmContent: "wasted_spend_general_static01",
    landingPage: "/offer/tracking-audit?utm_source=meta",
    fbp: "fb.1.123.456",
  },
};

const legacyAudit = {
  source: "tracking_audit_offer",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  websiteUrl: "https://legacy.example.com",
  monthlyAdSpend: "$1k - $5k / mo",
  adPlatforms: "Google Ads, Meta Ads",
};

const installProviderFetch = (options: { failReceiptOnce?: boolean; failTaskOnce?: boolean } = {}) => {
  let receiptAttempts = 0;
  let taskAttempts = 0;
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
    if (target === "https://api.brevo.com/v3/crm/deals") {
      return new Response(JSON.stringify({ id: "deal-1" }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/crm/tasks") {
      taskAttempts += 1;
      if (options.failTaskOnce && taskAttempts === 1) return new Response("", { status: 400 });
      return new Response(JSON.stringify({ id: "task-1" }), { status: 201 });
    }
    if (target === "https://api.brevo.com/v3/smtp/email") {
      const body = JSON.parse(String(init.body));
      if (body.subject === "We received your Tracking Audit application") {
        receiptAttempts += 1;
        if (options.failReceiptOnce && receiptAttempts === 1) return new Response("", { status: 400 });
      }
      return new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 });
    }
    if (target.includes("graph.facebook.com")) {
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

describe("Vercel leads application-first Tracking Audit flow", () => {
  beforeEach(() => {
    process.env.VITEST = "true";
    resetIdempotencyForTests();
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_CONTACT_LIST_ID = "8";
    process.env.BREVO_AUDIT_LIST_ID = "11";
    process.env.BREVO_NEWSLETTER_LIST_ID = "9";
    delete process.env.MONGODB_URI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of [
      "VITEST",
      "BREVO_API_KEY",
      "BREVO_CONTACT_LIST_ID",
      "BREVO_AUDIT_LIST_ID",
      "BREVO_NEWSLETTER_LIST_ID",
      "BREVO_DOI_TEMPLATE_ID",
      "BREVO_DOI_REDIRECT_URL",
      "META_PIXEL_ID",
      "META_CAPI_ACCESS_TOKEN",
      "META_GRAPH_API_VERSION",
      "META_CAPI_TEST_EVENT_CODE",
      "MONGODB_URI",
    ]) delete process.env[name];
  });

  it("captures a canonical audit application with structured fields, review task, receipt, and no Deal", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    process.env.META_CAPI_TEST_EVENT_CODE = "TEST123";
    const fetchMock = installProviderFetch();
    const { response, result } = buildResponse();

    await handler(buildRequest(canonicalAudit), response);

    expect(result()).toMatchObject({ statusCode: 200, payload: { ok: true, duplicate: false, metaEventId: "audit-event-1" } });
    const contactCall = callsFor(fetchMock, "/v3/contacts").find(([, init]) => String((init as RequestInit).method).toUpperCase() === "POST")!;
    const contactBody = JSON.parse(String((contactCall[1] as RequestInit).body));
    expect(contactBody).toMatchObject({
      email: "ama@example.com",
      listIds: [11],
      attributes: {
        COMPANY: "Example Co",
        WEBSITE_URL: "https://example.com",
        AUDIT_INDUSTRY: "professional_services",
        AUDIT_ROLE: "founder_ceo",
        AUDIT_DECISION_INFLUENCE: "final_decision_maker",
        AUDIT_AD_SPEND_BAND: "6000_14999",
        AUDIT_PAID_CHANNELS: ["meta_ads", "google_ads"],
        AUDIT_TRACKING_MATURITY: "disconnected",
        AUDIT_PRIMARY_CONVERSION: "lead_form",
        AUDIT_MEASUREMENT_PROBLEM: "conflicting_numbers",
        AUDIT_URGENCY: "before_scaling",
        AUDIT_STATUS: "Applied",
        AUDIT_HANDOFF_STATUS: "No Sales Handoff",
        UTM_SOURCE: "meta",
        UTM_CONTENT: "wasted_spend_general_static01",
      },
    });
    expect(contactBody.attributes.AUDIT_APPLIED_AT).toEqual(expect.any(String));
    expect(contactBody.attributes.AUDIT_LEGACY_AD_SPEND).toBe("");
    expect(callsFor(fetchMock, "/crm/deals")).toHaveLength(0);

    const taskBody = JSON.parse(String((callsFor(fetchMock, "/crm/tasks")[0][1] as RequestInit).body));
    expect(taskBody).toMatchObject({ contactsIds: [456], dealsIds: [], done: false });
    expect(taskBody.name).toContain("Review tracking audit application");

    const emailBodies = smtpBodies(fetchMock);
    expect(emailBodies.map((body) => body.subject)).toEqual(expect.arrayContaining([
      "New tracking audit application",
      "We received your Tracking Audit application",
    ]));
    expect(emailBodies.find((body) => body.subject === "We received your Tracking Audit application")?.to).toEqual([
      { email: "ama@example.com", name: "Ama Mensah" },
    ]);

    const metaCall = callsFor(fetchMock, "graph.facebook.com")[0];
    expect(JSON.parse(String((metaCall[1] as RequestInit).body))).toMatchObject({
      test_event_code: "TEST123",
      data: [{ event_name: "Lead", event_id: "audit-event-1", custom_data: { lead_source: "tracking_audit_offer" } }],
    });
  });

  it("routes legacy audit applications to Manual Review and preserves the original USD spend", async () => {
    const fetchMock = installProviderFetch();
    const { response, result } = buildResponse();
    await handler(buildRequest(legacyAudit), response);
    expect(result()).toMatchObject({ statusCode: 200, payload: { ok: true, duplicate: false } });

    const contactCall = callsFor(fetchMock, "/v3/contacts").find(([, init]) => String((init as RequestInit).method).toUpperCase() === "POST")!;
    const attrs = JSON.parse(String((contactCall[1] as RequestInit).body)).attributes;
    expect(attrs).toMatchObject({
      AUDIT_LEGACY_AD_SPEND: "$1k - $5k / mo",
      AUDIT_PAID_CHANNELS: ["google_ads", "meta_ads"],
      AUDIT_STATUS: "Manual Review",
      AUDIT_HANDOFF_STATUS: "No Sales Handoff",
      AUDIT_REVIEW_OUTCOME: "Manual Review",
    });
    expect(attrs.AUDIT_AD_SPEND_BAND).toBe("");
    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(1);
    expect(callsFor(fetchMock, "/crm/deals")).toHaveLength(0);
  });

  it("rejects invalid canonical enum values", async () => {
    const fetchMock = installProviderFetch();
    const { response, result } = buildResponse();
    await handler(buildRequest({ ...canonicalAudit, industry: "made_up_industry" }), response);
    expect(result()).toMatchObject({ statusCode: 400, payload: { ok: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppresses duplicate audit tasks, notifications, receipts, CAPI events, and all audit Deals", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    const fetchMock = installProviderFetch();

    const first = buildResponse();
    await handler(buildRequest(canonicalAudit), first.response);
    expect(first.result()).toMatchObject({ payload: { duplicate: false } });

    const second = buildResponse();
    await handler(buildRequest(canonicalAudit), second.response);
    expect(second.result()).toMatchObject({ payload: { duplicate: true } });

    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(1);
    expect(callsFor(fetchMock, "/crm/deals")).toHaveLength(0);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "New tracking audit application")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "We received your Tracking Audit application")).toHaveLength(1);
    expect(callsFor(fetchMock, "graph.facebook.com")).toHaveLength(1);
  });

  it("retries only a failed applicant receipt on duplicate submissions", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    const fetchMock = installProviderFetch({ failReceiptOnce: true });

    const first = buildResponse();
    await handler(buildRequest(canonicalAudit), first.response);
    expect(first.result()).toMatchObject({ statusCode: 200, payload: { duplicate: false } });

    const second = buildResponse();
    await handler(buildRequest(canonicalAudit), second.response);
    expect(second.result()).toMatchObject({ statusCode: 200, payload: { duplicate: true } });

    const third = buildResponse();
    await handler(buildRequest(canonicalAudit), third.response);
    expect(third.result()).toMatchObject({ statusCode: 200, payload: { duplicate: true } });

    expect(callsFor(fetchMock, "/v3/contacts").filter(([, init]) => String((init as RequestInit).method).toUpperCase() === "POST")).toHaveLength(1);
    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "New tracking audit application")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "We received your Tracking Audit application")).toHaveLength(2);
    expect(callsFor(fetchMock, "graph.facebook.com")).toHaveLength(1);
    expect(callsFor(fetchMock, "/crm/deals")).toHaveLength(0);
  });

  it("retries only a failed review task on a duplicate submission", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    const fetchMock = installProviderFetch({ failTaskOnce: true });

    const first = buildResponse();
    await handler(buildRequest(canonicalAudit), first.response);
    expect(first.result()).toMatchObject({ statusCode: 200, payload: { duplicate: false } });

    const second = buildResponse();
    await handler(buildRequest(canonicalAudit), second.response);
    expect(second.result()).toMatchObject({ statusCode: 200, payload: { duplicate: true } });

    expect(callsFor(fetchMock, "/v3/contacts").filter(([, init]) => String((init as RequestInit).method).toUpperCase() === "POST")).toHaveLength(1);
    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(2);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "New tracking audit application")).toHaveLength(1);
    expect(smtpBodies(fetchMock).filter((body) => body.subject === "We received your Tracking Audit application")).toHaveLength(1);
    expect(callsFor(fetchMock, "graph.facebook.com")).toHaveLength(1);
    expect(callsFor(fetchMock, "/crm/deals")).toHaveLength(0);
  });

  it("preserves contact-form Deal and Task behavior", async () => {
    const fetchMock = installProviderFetch();
    const { response, result } = buildResponse();
    await handler(buildRequest({
      source: "contact_form",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      company: "Analytical Engines Ltd",
      serviceInterest: ["Growth Strategy"],
      monthlyBudget: "$5,000+",
    }), response);
    expect(result()).toMatchObject({ statusCode: 200, payload: { ok: true, duplicate: false } });
    expect(callsFor(fetchMock, "/crm/deals")).toHaveLength(1);
    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(1);
  });

  it("preserves direct newsletter capture behavior", async () => {
    const fetchMock = installProviderFetch();
    const { response, result } = buildResponse();
    await handler(buildRequest({ source: "newsletter", firstName: "", lastName: "", email: "reader@example.com", optIn: true }), response);
    expect(result()).toMatchObject({ statusCode: 200, payload: { ok: true, duplicate: false } });
    expect(callsFor(fetchMock, "/crm/deals")).toHaveLength(0);
    expect(callsFor(fetchMock, "/crm/tasks")).toHaveLength(0);
    expect(smtpBodies(fetchMock).some((body) => body.subject === "New newsletter signup")).toBe(true);
  });
});