import { describe, expect, it } from "vitest";

import visitorCountryHandler from "../api/visitor-country";

const createResponse = () => {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown = undefined;

  const response = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
      return response;
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: unknown) {
      body = payload;
      return response;
    },
    end() {
      return response;
    },
  };

  return {
    response,
    snapshot: () => ({ headers, statusCode, body }),
  };
};

describe("Vercel visitor country endpoint", () => {
  it("returns the Vercel country header for UAT", () => {
    const { response, snapshot } = createResponse();
    const request = {
      method: "GET",
      headers: {
        origin: "https://atd-website-test.vercel.app",
        "x-vercel-ip-country": "GH",
      },
    };

    visitorCountryHandler(request as never, response as never);

    const result = snapshot();
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ ok: true, countryCode: "GH" });
    expect(result.headers.get("access-control-allow-origin")).toBe("https://atd-website-test.vercel.app");
  });

  it("returns null when Vercel has no country header", () => {
    const { response, snapshot } = createResponse();
    visitorCountryHandler({ method: "GET", headers: {} } as never, response as never);
    expect(snapshot().body).toEqual({ ok: true, countryCode: null });
  });

  it("rejects unsupported methods", () => {
    const { response, snapshot } = createResponse();
    visitorCountryHandler({ method: "POST", headers: {} } as never, response as never);
    expect(snapshot().statusCode).toBe(405);
  });
});
