import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/brevo-subscribe.mjs";
import { resetIdempotencyForTests } from "../netlify/functions/lib/idempotency.mjs";

const buildRequest = (body: Record<string, unknown>) =>
  new Request("https://alphatrack.digital/api/brevo-subscribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nf-client-connection-ip": `127.0.0.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify(body),
  });

describe("brevo-subscribe function", () => {
  beforeEach(() => {
    resetIdempotencyForTests();
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_LIST_ID = "7";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_LIST_ID;
    delete process.env.META_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_CAPI_TEST_EVENT_CODE;
  });

  it("sends exit popup contacts to Brevo with campaign attributes and updateEnabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      firstName: "Ada",
      email: "ADA@Example.com",
      website: "alphatrack.digital",
      route: "/",
      optIn: true,
      metaEventId: "atd-exit-popup-test-1",
      attribution: {
        utmSource: "linkedin",
        utmCampaign: "exit-audit",
        landingPage: "/services?utm_source=linkedin",
        referrer: "https://www.linkedin.com/",
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      metaEventId: "atd-exit-popup-test-1",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.brevo.com/v3/contacts", expect.objectContaining({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": "test-api-key",
      },
    }));

    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      email: "ada@example.com",
      attributes: {
        FIRSTNAME: "Ada",
        WEBSITE: "https://alphatrack.digital",
        SOURCE: "ATD Website Exit Popup",
        LEAD_SOURCE: "exit_popup",
        FIRST_SOURCE: "ATD Website Exit Popup",
        LAST_SOURCE: "ATD Website Exit Popup",
        FIRST_LEAD_SOURCE: "exit_popup",
        LAST_LEAD_SOURCE: "exit_popup",
        WEBSITE_ROUTE: "/",
        OFFER: "exit-popup",
        CONSENT_STATUS: "opted_in",
        OPT_IN: true,
        UTM_SOURCE: "linkedin",
        UTM_CAMPAIGN: "exit-audit",
        LANDING_PAGE: "/services?utm_source=linkedin",
        REFERRER: "https://www.linkedin.com/",
      },
      listIds: [7],
      updateEnabled: true,
    });
    expect(body.attributes.CONSENT_TIMESTAMP).toEqual(expect.any(String));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends exit popup leads to Meta CAPI with the browser event id", async () => {
    process.env.META_PIXEL_ID = "955663116586662";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    process.env.META_CAPI_TEST_EVENT_CODE = "TEST123";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      firstName: "Ada",
      email: "ADA@Example.com",
      website: "alphatrack.digital",
      route: "/",
      metaEventId: "atd-exit-popup-test-2",
      attribution: {
        fbp: "fb.1.123.456",
        fbc: "fb.1.123.abcdef",
        landingPage: "/?utm_source=meta",
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      duplicate: false,
      metaEventId: "atd-exit-popup-test-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://graph.facebook.com/v23.0/955663116586662/events?access_token=meta-token",
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      test_event_code: "TEST123",
      data: [
        {
          event_name: "Lead",
          event_id: "atd-exit-popup-test-2",
          action_source: "website",
          event_source_url: "https://alphatrack.digital/?utm_source=meta",
          user_data: {
            fbp: "fb.1.123.456",
            fbc: "fb.1.123.abcdef",
          },
          custom_data: {
            lead_source: "exit_popup",
            content_name: "Exit Popup Growth Audit",
            website_route: "/",
          },
        },
      ],
    });
  });

  it("returns a clean error when Brevo rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "sensitive provider detail" }), { status: 400 })),
    );

    const response = await handler(buildRequest({
      firstName: "Ada",
      email: "ada@example.com",
      website: "",
    }));

    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "Unable to submit lead right now.",
    });
    expect(response.status).toBe(502);
  });
});
