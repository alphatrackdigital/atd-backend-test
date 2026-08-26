import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../netlify/functions/brevo-transactional-webhook.mjs";

const webhookUrl = "https://alphatrack.digital/api/brevo-transactional-webhook";

const buildRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("brevo transactional webhook function", () => {
  beforeEach(() => {
    process.env.BREVO_TRANSACTIONAL_WEBHOOK_SECRET = "test-webhook-secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BREVO_TRANSACTIONAL_WEBHOOK_SECRET;
  });

  it("rejects unsigned webhook requests", async () => {
    const response = await handler(buildRequest({ event: "delivered" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "Unauthorized webhook request.",
    });
  });

  it("rejects webhook secrets supplied in the URL query string", async () => {
    const response = await handler(
      new Request(`${webhookUrl}?token=test-webhook-secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "delivered" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("accepts bearer-authenticated Brevo transactional events", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await handler(
      buildRequest(
        [
          { event: "delivered", tags: ["contact_form"], email: "ada@example.com" },
          { event: "softBounce", tag: "newsletter", email: "reader@example.com" },
        ],
        { authorization: "Bearer test-webhook-secret" },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      received: 2,
      byEvent: { delivered: 1, softBounce: 1 },
      byTag: { contact_form: 1, newsletter: 1 },
    });
    expect(infoSpy).toHaveBeenCalledWith("Brevo transactional webhook received.", {
      count: 2,
      byEvent: { delivered: 1, softBounce: 1 },
      byTag: { contact_form: 1, newsletter: 1 },
    });
  });

  it("accepts Brevo-style wrapped event batches", async () => {
    const response = await handler(
      buildRequest(
        { events: [{ event: "blocked", tags: ["tracking_audit_offer"] }] },
        { "x-atd-webhook-secret": "test-webhook-secret" },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      received: 1,
      byEvent: { blocked: 1 },
      byTag: { tracking_audit_offer: 1 },
    });
  });
});
