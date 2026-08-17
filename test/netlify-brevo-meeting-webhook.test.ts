import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/brevo-meeting-webhook.mjs";
import { resetIdempotencyForTests } from "../netlify/functions/lib/idempotency.mjs";

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

describe("brevo meeting webhook function", () => {
  beforeEach(() => {
    resetIdempotencyForTests();
    process.env.BREVO_MEETING_WEBHOOK_SECRET = "test-webhook-secret";
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

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

    const [, init] = fetchMock.mock.calls[0];
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
    process.env.BREVO_API_KEY = "test-api-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("https://www.google-analytics.com/mp/collect")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (url === "https://api.brevo.com/v3/contacts") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (url === "https://api.brevo.com/v3/contacts/lists/7/contacts/add") {
        return Promise.resolve(new Response(JSON.stringify({ code: "already_in_list" }), { status: 400 }));
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
    expect(warnSpy).toHaveBeenCalledWith(
      "Brevo booking list membership call failed after contact upsert",
      expect.objectContaining({ listId: 7 }),
    );
  });

  it("adds debug_mode only when explicitly enabled", async () => {
    process.env.GA4_MEASUREMENT_PROTOCOL_DEBUG_MODE = "true";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await handler(buildRequest(bookedPayload));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.events[0].params.debug_mode).toBe(true);
  });

  it("does not send duplicate booking conversions to GA4", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const firstResponse = await handler(buildRequest(bookedPayload));
    await expect(firstResponse.json()).resolves.toMatchObject({ ok: true, duplicate: false });

    const secondResponse = await handler(buildRequest(bookedPayload));
    await expect(secondResponse.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const ga4Calls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("https://www.google-analytics.com/mp/collect"),
    );
    expect(ga4Calls).toHaveLength(1);
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest(bookedPayload));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "GA4 Measurement Protocol is not configured.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
