import { afterEach, describe, expect, it } from "vitest";

import visitorCountryHandler from "../netlify/functions/visitor-country.mjs";

const originalContext = process.env.CONTEXT;

afterEach(() => {
  process.env.CONTEXT = originalContext;
});

describe("visitor country endpoint", () => {
  it("returns Ghana from Netlify geo context for the production site", async () => {
    process.env.CONTEXT = "production";
    const request = new Request("https://alphatra-serv.netlify.app/api/visitor-country", {
      headers: { origin: "https://alphatrack.digital" },
    });

    const response = await visitorCountryHandler(request, {
      geo: { country: { code: "GH", name: "Ghana" } },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://alphatrack.digital");
    await expect(response.json()).resolves.toEqual({ ok: true, countryCode: "GH" });
  });

  it("falls back to a null country when geo context is unavailable", async () => {
    process.env.CONTEXT = "production";
    const request = new Request("https://alphatra-serv.netlify.app/api/visitor-country", {
      headers: { origin: "https://alphatrack.digital" },
    });

    const response = await visitorCountryHandler(request, {});
    await expect(response.json()).resolves.toEqual({ ok: true, countryCode: null });
  });

  it("rejects disallowed browser origins in production", async () => {
    process.env.CONTEXT = "production";
    const request = new Request("https://alphatra-serv.netlify.app/api/visitor-country", {
      headers: { origin: "https://example.net" },
    });

    const response = await visitorCountryHandler(request, {
      geo: { country: { code: "GH", name: "Ghana" } },
    });

    expect(response.status).toBe(403);
  });
});
