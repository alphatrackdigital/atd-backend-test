import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/brevo-meeting-webhook.mjs";
import {
  resetIdempotencyForTests,
  setDurableIdempotencyStoreForTests,
} from "../netlify/functions/lib/idempotency.mjs";

const webhookUrl = "https://alphatrack.digital/api/brevo-meeting-webhook?token=test-webhook-secret";

const buildRequest = (body: Record<string, unknown>, url = webhookUrl) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const bookedPayload = {
  account_email: "owner@example.com",
  currency: "EUR",
  event_participants: [
    {
      EMAIL: "visitor@example.com",
      FIRSTNAME: "Ada",
      LASTNAME: "Lovelace",
    },
  ],
  meeting_id: "meeting-123",
  meeting_end_timestamp: "2026-05-28T08:15:00.000Z",
  meeting_location: "Brevo video call",
  meeting_name: "Discovery",
  meeting_start_timestamp: "2026-05-28T08:00:00.000Z",
};

const durableRecords = new Map<string, unknown>();

const installDurableStore = (options: { failGet?: boolean; failSetAt?: number } = {}) => {
  let setCount = 0;
  const store = {
    get: vi.fn(async (key: string) => {
      if (options.failGet) throw new Error("store unavailable");
      return structuredClone(durableRecords.get(key) ?? null);
    }),
    setJSON: vi.fn(async (key: string, value: unknown) => {
      setCount += 1;
      if (setCount === options.failSetAt) throw new Error("store unavailable");
      durableRecords.set(key, structuredClone(value));
    }),
  };
  setDurableIdempotencyStoreForTests(store);
  return store;
};

const installSuccessfulFetch = (options: {
  ga4Failures?: number;
  ga4FailureStatus?: number;
  dealFailures?: number;
  dealFailureStatus?: number;
  dealNetworkFailures?: number;
  taskFailures?: number;
  taskFailureStatus?: number;
} = {}) => {
  let ga4Failures = options.ga4Failures ?? 0;
  let dealFailures = options.dealFailures ?? 0;
  let dealNetworkFailures = options.dealNetworkFailures ?? 0;
  let taskFailures = options.taskFailures ?? 0;
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "https://api.brevo.com/v3/contacts/visitor%40example.com") {
      return Promise.resolve(new Response(JSON.stringify({ id: 321 }), { status: 200 }));
    }
    if (url === "https://api.brevo.com/v3/contacts") {
      return Promise.resolve(new Response(JSON.stringify({ id: 321 }), { status: 201 }));
    }
    if (url === "https://api.brevo.com/v3/crm/deals") {
      if (dealNetworkFailures > 0) {
        dealNetworkFailures -= 1;
        return Promise.reject(new Error("network unavailable"));
      }
      if (dealFailures > 0) {
        dealFailures -= 1;
        return Promise.resolve(new Response(null, { status: options.dealFailureStatus ?? 400 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "deal-321" }), { status: 201 }));
    }
    if (url === "https://api.brevo.com/v3/crm/tasks") {
      if (taskFailures > 0) {
        taskFailures -= 1;
        return Promise.resolve(new Response(null, { status: options.taskFailureStatus ?? 503 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "task-321" }), { status: 201 }));
    }
    if (url.startsWith("https://www.google-analytics.com/mp/collect")) {
      if (ga4Failures > 0) {
        ga4Failures -= 1;
        return Promise.resolve(new Response(null, { status: options.ga4FailureStatus ?? 400 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.startsWith("https://graph.facebook.com/")) {
      return Promise.resolve(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    }
    if (url === "https://api.brevo.com/v3/smtp/email") {
      return Promise.resolve(new Response(JSON.stringify({ messageId: "message-321" }), { status: 201 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const callsTo = (fetchMock: ReturnType<typeof vi.fn>, url: string) =>
  fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl) === url);

describe("brevo meeting webhook function", () => {
  beforeEach(() => {
    resetIdempotencyForTests();
    durableRecords.clear();
    installDurableStore();
    process.env.BREVO_MEETING_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_STRATEGY_CALL_LIST_ID = "7";
    process.env.GA4_MEASUREMENT_ID = "G-TEST1234";
    process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET = "ga4-secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BREVO_MEETING_WEBHOOK_SECRET;
    delete process.env.GA4_MEASUREMENT_ID;
    delete process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET;
    delete process.env.GA4_MEASUREMENT_PROTOCOL_DEBUG_MODE;
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_STRATEGY_CALL_LIST_ID;
  });

  it("rejects unsigned webhook requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest(bookedPayload, "https://alphatrack.digital/api/brevo-meeting-webhook"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "Unauthorized webhook request.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tracks Brevo meeting bookings in GA4 without sending participant PII", async () => {
    const fetchMock = installSuccessfulFetch();

    const response = await handler(buildRequest(bookedPayload));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, crm: true, duplicate: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.google-analytics.com/mp/collect?measurement_id=G-TEST1234&api_secret=ga4-secret",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );

    const [, init] = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("https://www.google-analytics.com/mp/collect"),
    )!;
    const body = JSON.parse(init.body);

    expect(body).toMatchObject({
      non_personalized_ads: true,
      events: [
        {
          name: ["meeting", "booked", "confirmed"].join("_"),
          params: {
            booking_id: "meeting-123",
            booking_email_present: true,
            meeting_name: "Discovery",
            meeting_start_timestamp: "2026-05-28T08:00:00.000Z",
            meeting_end_timestamp: "2026-05-28T08:15:00.000Z",
            meeting_location: "Brevo video call",
            source: "brevo_meetings_webhook",
            page_location: "https://alphatrack.digital/book-a-call",
            page_title: "Book A Free Strategy Call | AlphaTrack Digital",
            session_id: "1779955200",
            engagement_time_msec: 1,
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("visitor@example.com");
    expect(JSON.stringify(body)).not.toContain("Ada");
    expect(JSON.stringify(body)).not.toContain("Lovelace");
  });

  it("sends an internal sales alert for real strategy call bookings", async () => {
    const fetchMock = installSuccessfulFetch();

    const response = await handler(buildRequest(bookedPayload));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, duplicate: false });

    const notificationCall = fetchMock.mock.calls.find(([url]) => url === "https://api.brevo.com/v3/smtp/email");
    expect(notificationCall).toBeTruthy();
    const [, notificationInit] = notificationCall!;
    expect(JSON.parse(notificationInit.body)).toMatchObject({
      sender: { name: "AlphaTrack Digital", email: "sales@alphatrack.digital" },
      replyTo: { email: "sales@alphatrack.digital", name: "AlphaTrack Digital" },
      to: [{ email: "sales@alphatrack.digital" }, { email: "martech@alphatrack.digital" }],
      subject: "New strategy call booking",
      tags: ["brevo_meetings_webhook"],
    });
  });

  it("looks up an existing Brevo contact before CRM handoff when booking upsert does not return an id", async () => {
    process.env.BREVO_API_KEY = "test-api-key";
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("https://www.google-analytics.com/mp/collect")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (url === "https://api.brevo.com/v3/contacts") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (url === "https://api.brevo.com/v3/contacts/visitor%40example.com") {
        return Promise.resolve(new Response(JSON.stringify({ id: 321 }), { status: 200 }));
      }

      if (url === "https://api.brevo.com/v3/crm/deals") {
        return Promise.resolve(new Response(JSON.stringify({ id: "deal-321" }), { status: 201 }));
      }

      if (url === "https://api.brevo.com/v3/crm/tasks") {
        return Promise.resolve(new Response(JSON.stringify({ id: "task-321" }), { status: 201 }));
      }

      if (url === "https://api.brevo.com/v3/smtp/email") {
        return Promise.resolve(new Response(JSON.stringify({ messageId: "message-321" }), { status: 201 }));
      }

      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest(bookedPayload));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, crm: true, duplicate: false });

    const contactLookupCall = fetchMock.mock.calls.find(([url]) =>
      url === "https://api.brevo.com/v3/contacts/visitor%40example.com"
    );
    expect(contactLookupCall).toBeTruthy();

    const contactUpsertCall = fetchMock.mock.calls.find(([url]) => url === "https://api.brevo.com/v3/contacts");
    expect(JSON.parse(contactUpsertCall![1].body)).toMatchObject({ listIds: [7], updateEnabled: true });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/contacts/lists/"))).toBe(false);

    const dealCall = fetchMock.mock.calls.find(([url]) => url === "https://api.brevo.com/v3/crm/deals");
    expect(dealCall).toBeTruthy();
    const [dealUrl, dealInit] = dealCall!;
    expect(dealUrl).toBe("https://api.brevo.com/v3/crm/deals");
    expect(JSON.parse(dealInit.body)).toMatchObject({
      linkedContactsIds: [321],
      attributes: {
        pipeline: "68bf7ba1f6e11688cf7a2164",
        deal_stage: "bc2f86a0-8374-479f-bd43-27675c04e31a",
      },
    });
  });

  it("reports CRM failure without failing an authenticated booking webhook", async () => {
    process.env.BREVO_API_KEY = "test-api-key";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("https://www.google-analytics.com/mp/collect")) return Promise.resolve(new Response(null, { status: 204 }));
      if (url === "https://api.brevo.com/v3/contacts/visitor%40example.com") return Promise.resolve(new Response(JSON.stringify({ id: 321 }), { status: 200 }));
      if (url === "https://api.brevo.com/v3/contacts") return Promise.resolve(new Response(JSON.stringify({ id: 321 }), { status: 201 }));
      if (url === "https://api.brevo.com/v3/crm/deals") return Promise.resolve(new Response(JSON.stringify({ message: "plan limit" }), { status: 400 }));
      if (url === "https://api.brevo.com/v3/smtp/email") return Promise.resolve(new Response(JSON.stringify({ messageId: "message-321" }), { status: 201 }));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest(bookedPayload));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, crm: false, duplicate: false });
    expect(errorSpy).toHaveBeenCalledWith(
      "Brevo meeting booking processing incomplete.",
      expect.objectContaining({ failed_steps: expect.arrayContaining([expect.objectContaining({ step: "crmDeal" })]) }),
    );
  });

  it("adds debug_mode only when explicitly enabled", async () => {
    process.env.GA4_MEASUREMENT_PROTOCOL_DEBUG_MODE = "true";
    const fetchMock = installSuccessfulFetch();

    await handler(buildRequest(bookedPayload));

    const [, init] = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("https://www.google-analytics.com/mp/collect"),
    )!;
    const body = JSON.parse(init.body);
    expect(body.events[0].params.debug_mode).toBe(true);
  });

  it("does not send duplicate booking conversions to GA4", async () => {
    const fetchMock = installSuccessfulFetch();

    const firstResponse = await handler(buildRequest(bookedPayload));
    await expect(firstResponse.json()).resolves.toMatchObject({ ok: true, duplicate: false });

    const secondResponse = await handler(buildRequest(bookedPayload));
    await expect(secondResponse.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const ga4Calls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("https://www.google-analytics.com/mp/collect"),
    );
    expect(ga4Calls).toHaveLength(1);
  });

  it("accepts the supported header authentication", async () => {
    installSuccessfulFetch();
    const response = await handler(
      new Request("https://alphatrack.digital/api/brevo-meeting-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-atd-webhook-secret": "test-webhook-secret",
        },
        body: JSON.stringify(bookedPayload),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, crm: true, duplicate: false });
  });

  it("retains the historical Meetings query-token fallback", async () => {
    installSuccessfulFetch();
    const response = await handler(buildRequest(bookedPayload));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, crm: true, duplicate: false });
  });

  it("does not repeat CRM when GA4 fails after CRM succeeds and delivery is retried", async () => {
    const fetchMock = installSuccessfulFetch({ ga4Failures: 1 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const firstResponse = await handler(buildRequest(bookedPayload));
    expect(firstResponse.status).toBe(503);
    await expect(firstResponse.json()).resolves.toMatchObject({ ok: false, crm: true });

    const retryResponse = await handler(buildRequest(bookedPayload));
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({ ok: true, crm: true, duplicate: true });

    expect(callsTo(fetchMock, "https://api.brevo.com/v3/contacts")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/tasks")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("https://www.google-analytics.com/mp/collect"),
    )).toHaveLength(2);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/smtp/email")).toHaveLength(1);
  });

  it("retries a definite CRM 400 rejection without repeating completed analytics or notification", async () => {
    const fetchMock = installSuccessfulFetch({ dealFailures: 1 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const firstResponse = await handler(buildRequest(bookedPayload));
    expect(firstResponse.status).toBe(503);
    await expect(firstResponse.json()).resolves.toMatchObject({ ok: false, crm: false });

    const retryResponse = await handler(buildRequest(bookedPayload));
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({ ok: true, crm: true, duplicate: true });

    expect(callsTo(fetchMock, "https://api.brevo.com/v3/contacts")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(2);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/tasks")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("https://www.google-analytics.com/mp/collect"),
    )).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/smtp/email")).toHaveLength(1);
  });

  it("fails closed when CRM deal creation returns an ambiguous 503", async () => {
    const fetchMock = installSuccessfulFetch({ dealFailures: 1, dealFailureStatus: 503 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const firstResponse = await handler(buildRequest(bookedPayload));
    expect(firstResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
    expect(Array.from(durableRecords.values())[0]).toMatchObject({
      steps: { crmDeal: { status: "started" } },
    });

    const retryResponse = await handler(buildRequest(bookedPayload));
    expect(retryResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/tasks")).toHaveLength(0);
  });

  it("does not replay a completed deal or an ambiguously failed task", async () => {
    const fetchMock = installSuccessfulFetch({ taskFailures: 1, taskFailureStatus: 503 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const firstResponse = await handler(buildRequest(bookedPayload));
    expect(firstResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/tasks")).toHaveLength(1);
    expect(Array.from(durableRecords.values())[0]).toMatchObject({
      steps: {
        crmDeal: { status: "completed", dealId: "deal-321" },
        crmTask: { status: "started" },
      },
    });

    const retryResponse = await handler(buildRequest(bookedPayload));
    expect(retryResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/tasks")).toHaveLength(1);
  });

  it("fails closed when CRM deal creation has a network failure", async () => {
    const fetchMock = installSuccessfulFetch({ dealNetworkFailures: 1 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const firstResponse = await handler(buildRequest(bookedPayload));
    expect(firstResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
    expect(Array.from(durableRecords.values())[0]).toMatchObject({
      steps: { crmDeal: { status: "started" } },
    });

    const retryResponse = await handler(buildRequest(bookedPayload));
    expect(retryResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
  });

  it("makes a fully completed duplicate delivery side-effect free", async () => {
    process.env.META_PIXEL_ID = "test-pixel";
    process.env.META_CAPI_ACCESS_TOKEN = "test-meta-token";
    const fetchMock = installSuccessfulFetch();
    const firstResponse = await handler(buildRequest(bookedPayload));
    expect(firstResponse.status).toBe(200);
    const callsAfterSuccess = fetchMock.mock.calls.length;

    const duplicateResponse = await handler(buildRequest(bookedPayload));
    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toEqual({ ok: true, crm: true, duplicate: true });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterSuccess);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/contacts")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/tasks")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/smtp/email")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://graph.facebook.com/"))).toHaveLength(1);
  });

  it("fails before side effects when durable idempotency lookup is unavailable", async () => {
    installDurableStore({ failGet: true });
    const fetchMock = installSuccessfulFetch();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(buildRequest(bookedPayload));
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before a side effect when its started checkpoint cannot be stored", async () => {
    installDurableStore({ failSetAt: 1 });
    const fetchMock = installSuccessfulFetch();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(buildRequest(bookedPayload));
    expect(response.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/contacts")).toHaveLength(0);
  });

  it("fails closed after a side effect whose completion checkpoint cannot be stored", async () => {
    installDurableStore({ failSetAt: 2 });
    const fetchMock = installSuccessfulFetch();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const firstResponse = await handler(buildRequest(bookedPayload));
    expect(firstResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/contacts")).toHaveLength(1);

    const retryResponse = await handler(buildRequest(bookedPayload));
    expect(retryResponse.status).toBe(503);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/contacts")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.brevo.com/v3/crm/deals")).toHaveLength(0);
  });

  it("ignores cancel-style payloads", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      ...bookedPayload,
      event: "meeting_cancelled",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a configuration error when GA4 Measurement Protocol is missing", async () => {
    delete process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET;
    installSuccessfulFetch();

    const response = await handler(buildRequest(bookedPayload));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      crm: true,
      message: "Booking processing is incomplete; retry required.",
    });
  });
});
