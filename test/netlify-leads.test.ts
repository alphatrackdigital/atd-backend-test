import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/leads.mjs";
import { resetIdempotencyForTests } from "../netlify/functions/lib/idempotency.mjs";

const buildRequest = (body: Record<string, unknown>) =>
  new Request("https://alphatrack.digital/api/leads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nf-client-connection-ip": `127.1.0.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify(body),
  });

describe("leads function", () => {
  beforeEach(() => {
    resetIdempotencyForTests();
    process.env.BREVO_API_KEY = "test-api-key";
    process.env.BREVO_CONTACT_LIST_ID = "8";
    process.env.BREVO_AUDIT_LIST_ID = "11";
    process.env.BREVO_NEWSLETTER_LIST_ID = "9";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_CONTACT_LIST_ID;
    delete process.env.BREVO_AUDIT_LIST_ID;
    delete process.env.BREVO_NEWSLETTER_LIST_ID;
    delete process.env.BREVO_DOI_TEMPLATE_ID;
    delete process.env.BREVO_DOI_REDIRECT_URL;
    delete process.env.META_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_CAPI_TEST_EVENT_CODE;
    delete process.env.META_GRAPH_API_VERSION;
  });

  it("routes contact enquiries to the contact list and info inbox", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["ada@example.com"], failure: [] } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deal-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      source: "contact_form",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      company: "Analytical Engines Ltd",
      websiteUrl: "https://example.com",
      serviceInterest: ["Growth Strategy"],
      monthlyBudget: "$5,000+",
      message: "Need help with attribution.",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, pendingConfirmation: false, duplicate: false });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const [, contactInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(contactInit.body)).toMatchObject({
      email: "ada@example.com",
      listIds: [8],
      attributes: {
        FIRSTNAME: "Ada",
        LASTNAME: "Lovelace",
        COMPANY: "Analytical Engines Ltd",
        WEBSITE: "https://example.com",
        MESSAGE: "Need help with attribution.",
        SOURCE: "Contact Form",
        FIRST_SOURCE: "Contact Form",
        LAST_SOURCE: "Contact Form",
        FIRST_LEAD_SOURCE: "contact_form",
        LAST_LEAD_SOURCE: "contact_form",
        SERVICE_INTEREST: ["Growth Strategy"],
        MONTHLY_BUDGET: "4",
        LEAD_SOURCE: "contact_form",
        WEBSITE_ROUTE: "/contact-us",
        OFFER: "general-enquiry",
        CONSENT_STATUS: "not_provided",
      },
    });

    const [listUrl, listInit] = fetchMock.mock.calls[2];
    expect(listUrl).toBe("https://api.brevo.com/v3/contacts/lists/8/contacts/add");
    expect(JSON.parse(listInit.body)).toEqual({ emails: ["ada@example.com"] });

    const [dealUrl, dealInit] = fetchMock.mock.calls[3];
    expect(dealUrl).toBe("https://api.brevo.com/v3/crm/deals");
    expect(JSON.parse(dealInit.body)).toMatchObject({
      name: "Analytical Engines Ltd - General enquiry",
      attributes: {
        deal_owner: "68bf7b64faf0e9c68b0ccdb4",
        pipeline: "68bf7ba1f6e11688cf7a2164",
        deal_stage: "089c5fc7-da86-489a-a3b5-503bc5d4bd54",
      },
      linkedContactsIds: [123],
    });

    const [taskUrl, taskInit] = fetchMock.mock.calls[4];
    expect(taskUrl).toBe("https://api.brevo.com/v3/crm/tasks");
    expect(JSON.parse(taskInit.body)).toMatchObject({
      name: "Reply to contact enquiry - Analytical Engines Ltd",
      taskTypeId: "68bf7ba1f6e11688cf7a215e",
      assignToId: "68bf7b64faf0e9c68b0ccdb4",
      contactsIds: [123],
      dealsIds: ["deal-1"],
      done: false,
    });

    const [notificationUrl, notificationInit] = fetchMock.mock.calls[5];
    expect(notificationUrl).toBe("https://api.brevo.com/v3/smtp/email");
    expect(JSON.parse(notificationInit.body)).toMatchObject({
      sender: { name: "AlphaTrack Digital", email: "info@alphatrack.digital" },
      replyTo: { email: "info@alphatrack.digital", name: "AlphaTrack Digital" },
      to: [{ email: "info@alphatrack.digital" }],
      subject: "New website contact form enquiry",
      tags: ["contact_form"],
    });
  });

  it("routes tracking audit leads to the audit list and audit inboxes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 456 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["grace@example.com"], failure: [] } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deal-2" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task-2" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-2" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      source: "tracking_audit_offer",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      websiteUrl: "https://example.com",
      monthlyAdSpend: "5k to 20k per month",
      adPlatforms: "Google Ads, Meta Ads",
      optIn: true,
    }));

    expect(response.status).toBe(200);

    const [, contactInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(contactInit.body)).toMatchObject({
      email: "grace@example.com",
      listIds: [11],
      attributes: {
        FIRSTNAME: "Grace",
        LASTNAME: "Hopper",
        SOURCE: "Tracking Audit Landing Page",
        FIRST_SOURCE: "Tracking Audit Landing Page",
        LAST_SOURCE: "Tracking Audit Landing Page",
        FIRST_LEAD_SOURCE: "tracking_audit_offer",
        LAST_LEAD_SOURCE: "tracking_audit_offer",
        WEBSITE: "https://example.com",
        AD_SPEND: "5k to 20k per month",
        AD_PLATFORMS: "Google Ads, Meta Ads",
        OPT_IN: true,
        LEAD_SOURCE: "tracking_audit_offer",
        WEBSITE_ROUTE: "/offer/tracking-audit",
        OFFER: "tracking-audit",
        CONSENT_STATUS: "opted_in",
      },
    });
    expect(JSON.parse(contactInit.body).attributes.CONSENT_TIMESTAMP).toEqual(expect.any(String));

    const [listUrl, listInit] = fetchMock.mock.calls[2];
    expect(listUrl).toBe("https://api.brevo.com/v3/contacts/lists/11/contacts/add");
    expect(JSON.parse(listInit.body)).toEqual({ emails: ["grace@example.com"] });

    const [dealUrl, dealInit] = fetchMock.mock.calls[3];
    expect(dealUrl).toBe("https://api.brevo.com/v3/crm/deals");
    expect(JSON.parse(dealInit.body)).toMatchObject({
      name: "https://example.com - Tracking audit",
      attributes: {
        deal_owner: "68bf7b64faf0e9c68b0ccdb4",
        pipeline: "68bf7ba1f6e11688cf7a2164",
        deal_stage: "8dae99f7-6de0-4c1f-9ca6-b5ee72a40d85",
      },
      linkedContactsIds: [456],
    });

    const [taskUrl, taskInit] = fetchMock.mock.calls[4];
    expect(taskUrl).toBe("https://api.brevo.com/v3/crm/tasks");
    expect(JSON.parse(taskInit.body)).toMatchObject({
      name: "Review tracking audit request - https://example.com",
      taskTypeId: "68bf7ba1f6e11688cf7a215e",
      assignToId: "68bf7b64faf0e9c68b0ccdb4",
      contactsIds: [456],
      dealsIds: ["deal-2"],
      done: false,
    });

    const [notificationUrl, notificationInit] = fetchMock.mock.calls[5];
    expect(notificationUrl).toBe("https://api.brevo.com/v3/smtp/email");
    expect(JSON.parse(notificationInit.body)).toMatchObject({
      sender: { name: "AlphaTrack Digital", email: "audit@alphatrack.digital" },
      replyTo: { email: "audit@alphatrack.digital", name: "AlphaTrack Digital" },
      to: [{ email: "audit@alphatrack.digital" }, { email: "martech@alphatrack.digital" }],
      subject: "New tracking audit request",
      tags: ["tracking_audit_offer"],
    });
  });

  it("sends configured lead captures to Meta Conversions API", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";
    process.env.META_CAPI_TEST_EVENT_CODE = "TEST123";
    process.env.META_GRAPH_API_VERSION = "v23.0";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["ada@example.com"], failure: [] } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deal-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      source: "contact_form",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      serviceInterest: ["Growth Strategy"],
      metaEventId: "atd-test-event-1",
      attribution: {
        fbp: "fb.1.123.456",
        fbc: "fb.1.123.click",
        landingPage: "/contact-us?utm_source=meta&utm_campaign=launch",
        utmSource: "meta",
        utmCampaign: "launch",
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      metaEventId: "atd-test-event-1",
    });

    const [metaUrl, metaInit] = fetchMock.mock.calls[6];
    expect(metaUrl).toBe("https://graph.facebook.com/v23.0/123456789/events?access_token=meta-token");

    const metaPayload = JSON.parse(metaInit.body);
    expect(metaPayload).toMatchObject({
      test_event_code: "TEST123",
      data: [
        {
          event_name: "Lead",
          event_id: "atd-test-event-1",
          action_source: "website",
          event_source_url: "https://alphatrack.digital/contact-us?utm_source=meta&utm_campaign=launch",
          user_data: {
            fbp: "fb.1.123.456",
            fbc: "fb.1.123.click",
          },
          custom_data: {
            lead_source: "contact_form",
            content_name: "Contact Form",
            website_route: "/contact-us",
            utm_source: "meta",
            utm_campaign: "launch",
          },
        },
      ],
    });
    expect(metaPayload.data[0].user_data.em[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps tracking audit captures to Meta Lead with the browser event ID", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 456 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["grace@example.com"], failure: [] } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deal-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      source: "tracking_audit_offer",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      websiteUrl: "https://example.com",
      monthlyAdSpend: "5k to 20k per month",
      adPlatforms: "Google Ads, Meta Ads",
      metaEventId: "atd-tracking-audit-event-1",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      metaEventId: "atd-tracking-audit-event-1",
    });

    const [, metaInit] = fetchMock.mock.calls[6];
    expect(JSON.parse(metaInit.body)).toMatchObject({
      data: [{
        event_name: "Lead",
        event_id: "atd-tracking-audit-event-1",
        custom_data: {
          lead_source: "tracking_audit_offer",
          content_name: "Tracking Audit Landing Page",
          website_route: "/offer/tracking-audit",
        },
      }],
    });
  });

  it("does not fail lead capture when Meta Conversions API rejects the event", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["ada@example.com"], failure: [] } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deal-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Bad token" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(buildRequest({
      source: "contact_form",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      serviceInterest: ["Growth Strategy"],
      metaEventId: "atd-test-event-2",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      metaEventId: "atd-test-event-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("captures tracking audit leads safely when Meta CAPI env vars are missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 456 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["grace@example.com"], failure: [] } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "deal-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await handler(buildRequest({
      source: "tracking_audit_offer",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      websiteUrl: "https://example.com",
      monthlyAdSpend: "5k to 20k per month",
      adPlatforms: "Google Ads, Meta Ads",
      metaEventId: "atd-tracking-audit-no-capi",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, duplicate: false });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"))).toHaveLength(0);
  });

  it("does not expose Brevo provider details when lead capture fails", async () => {
    const providerDetail = "sensitive provider detail: internal contact validation context";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(providerDetail, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(buildRequest({
      source: "contact_form",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      serviceInterest: ["Growth Strategy"],
    }));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({ ok: false, message: "Unable to submit lead right now." });
    expect(JSON.stringify(body)).not.toContain(providerDetail);
    expect(errorSpy).toHaveBeenCalledWith("Brevo lead capture failed", {
      source: "contact_form",
      listId: 8,
      message: providerDetail,
    });
  });

  it("does not resend notifications for duplicate tracking audit submissions", async () => {
    process.env.META_PIXEL_ID = "123456789";
    process.env.META_CAPI_ACCESS_TOKEN = "meta-token";

    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 456 }), { status: 201 })));
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      source: "tracking_audit_offer",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      websiteUrl: "https://example.com",
      monthlyAdSpend: "5k to 20k per month",
      adPlatforms: "Google Ads, Meta Ads",
      optIn: true,
      metaEventId: "atd-tracking-audit-dedupe-1",
    };

    const firstResponse = await handler(buildRequest(payload));
    await expect(firstResponse.json()).resolves.toMatchObject({ ok: true, duplicate: false });

    const secondResponse = await handler(buildRequest(payload));
    await expect(secondResponse.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://api.brevo.com/v3/smtp/email")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"))).toHaveLength(1);
  });

  it("falls back to direct newsletter capture when Brevo DOI is not active", async () => {
    process.env.BREVO_DOI_TEMPLATE_ID = "42";
    process.env.BREVO_DOI_REDIRECT_URL = "https://alphatrack.digital/newsletter/confirmed";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "invalid_parameter", message: "An active DOI template does not exist" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 789 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: { success: ["reader@example.com"], failure: [] } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "message-3" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(buildRequest({
      source: "newsletter",
      firstName: "",
      lastName: "",
      email: "reader@example.com",
      optIn: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, pendingConfirmation: false, duplicate: false });

    expect(fetchMock.mock.calls[1][0]).toBe("https://api.brevo.com/v3/contacts/doubleOptinConfirmation");
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.brevo.com/v3/contacts");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      email: "reader@example.com",
      listIds: [9],
      attributes: {
        SOURCE: "Newsletter",
        FIRST_SOURCE: "Newsletter",
        LAST_SOURCE: "Newsletter",
        FIRST_LEAD_SOURCE: "newsletter",
        LAST_LEAD_SOURCE: "newsletter",
        OPT_IN: true,
        LEAD_SOURCE: "newsletter",
        WEBSITE_ROUTE: "/newsletter",
        OFFER: "newsletter-signup",
        CONSENT_STATUS: "opted_in",
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).attributes.CONSENT_TIMESTAMP).toEqual(expect.any(String));
    expect(fetchMock.mock.calls[3][0]).toBe("https://api.brevo.com/v3/contacts/lists/9/contacts/add");

    const [notificationUrl, notificationInit] = fetchMock.mock.calls[4];
    expect(notificationUrl).toBe("https://api.brevo.com/v3/smtp/email");
    expect(JSON.parse(notificationInit.body)).toMatchObject({
      sender: { name: "AlphaTrack Digital", email: "marketing@alphatrack.digital" },
      replyTo: { email: "marketing@alphatrack.digital", name: "AlphaTrack Digital" },
      to: [{ email: "marketing@alphatrack.digital" }],
      subject: "New newsletter signup",
      tags: ["newsletter"],
    });
  });
});
