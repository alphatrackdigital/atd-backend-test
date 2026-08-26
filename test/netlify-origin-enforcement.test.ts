import { afterEach, describe, expect, it, vi } from "vitest";
import leadsHandler from "../netlify/functions/leads.mjs";
import subscribeHandler from "../netlify/functions/brevo-subscribe.mjs";

const endpoints = [
  ["leads", "https://alphatrack.digital/api/leads", leadsHandler],
  ["brevo-subscribe", "https://alphatrack.digital/api/brevo-subscribe", subscribeHandler],
] as const;

const request = (url: string, method: string, origin?: string) =>
  new Request(url, {
    method,
    headers: origin ? { origin } : undefined,
    ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) } } : {}),
  });

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONTEXT;
  delete process.env.ALLOWED_ORIGINS;
});

describe.each(endpoints)("%s production origin enforcement", (_name, url, handler) => {
  it.each(["https://alphatrack.digital", "https://www.alphatrack.digital"])(
    "accepts canonical production origin %s",
    async (origin) => {
      process.env.CONTEXT = "production";
      const response = await handler(request(url, "OPTIONS", origin));
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    },
  );

  it.each([
    "https://feature-alphatrackdigitals-projects.vercel.app",
    "https://feature--alphatrackdigital.netlify.app",
    "https://hostile.example",
  ])("rejects supplied origin %s in production before side effects", async (origin) => {
    process.env.CONTEXT = "production";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handler(request(url, "POST", origin));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an explicitly configured QA origin outside production", async () => {
    process.env.CONTEXT = "deploy-preview";
    process.env.ALLOWED_ORIGINS = "https://qa.example";
    const response = await handler(request(url, "OPTIONS", "https://qa.example"));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://qa.example");
  });

  it("preserves no-Origin OPTIONS behavior for server-to-server clients", async () => {
    process.env.CONTEXT = "production";
    const response = await handler(request(url, "OPTIONS"));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
