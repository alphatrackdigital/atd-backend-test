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

  return {
    response,
    result: () => ({ statusCode, payload, headers }),
  };
};

const trackingAuditPayload = {
  source: "tracking_audit_offer",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  websiteUrl: "https://example.com",
  monthlyAdSpend: "5k to 20k per month",
  adPlatforms: "Google Ads, Meta Ads",
  metaEventId: "atd-tracking-audit-event-1",
};

const successfulCaptureFetch = () =>
  vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 456 }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["grace@example.com"], failure: [] } }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deal-1" }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task-1" }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 }));

describe("Vercel leads handler Meta CAPI", () => {
  beforeEach(() => {
    process.env.VITEST = "true";
    resetIdempotencyForTests();
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_AUDIT_LIST_ID = "11";
    delete process.env.MONGODB_URI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VITEST;
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_AUDIT_LIST_ID;
    delete process.env.META_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_GRAPH_API_VERSION;
    delete process.env.META_CAPI_TEST_EVENT_CODE;
  });

  it("maps tracking audit to Meta Lead with the submitted browser event ID", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    process.env.META_CAPI_TEST_EVENT_CODE = "TEST123";

    const fetchMock = successfulCaptureFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { response, result } = buildResponse();

    await handler(buildRequest(trackingAuditPayload), response);

    expect(result()).toMatchObject({
      statusCode: 200,
      payload: {
        ok: true,
        duplicate: false,
        metaEventId: "atd-tracking-audit-event-1",
      },
    });
    const [metaUrl, metaInit] = fetchMock.mock.calls[6];
    expect(metaUrl).toContain("https://graph.facebook.com/v23.0/123456789/events");
    expect(JSON.parse(metaInit.body)).toMatchObject({
      test_event_code: "TEST123",
      data: [{
        event_name: "Lead",
        event_id: "atd-tracking-audit-event-1",
        custom_data: {
          lead_source: "tracking_audit_offer",
          website_route: "/offer/tracking-audit",
        },
      }],
    });
  });

  it("captures the lead safely when required Meta env vars are missing", async () => {
    const fetchMock = successfulCaptureFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { response, result } = buildResponse();

    await handler(buildRequest(trackingAuditPayload), response);

    expect(result()).toMatchObject({ statusCode: 200, payload: { ok: true, duplicate: false } });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"))).toHaveLength(0);
  });

  it("skips CRM, notification, and CAPI for duplicate tracking audits", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ id: 456 }), { status: 201 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = buildResponse();
    await handler(buildRequest(trackingAuditPayload), first.response);
    expect(first.result()).toMatchObject({ payload: { duplicate: false } });

    const second = buildResponse();
    await handler(buildRequest(trackingAuditPayload), second.response);
    expect(second.result()).toMatchObject({ payload: { duplicate: true } });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/crm/deals"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/crm/tasks"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/smtp/email"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"))).toHaveLength(1);
  });
});
