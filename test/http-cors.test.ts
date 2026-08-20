import { afterEach, describe, expect, it } from "vitest";
import { corsHeaders, isAllowedBrowserOrigin } from "../netlify/functions/lib/http";

const resetEnv = () => {
  delete process.env.CONTEXT;
  delete process.env.ALLOWED_ORIGINS;
};

afterEach(resetEnv);

describe("Netlify browser origin policy", () => {
  it("allows only canonical live origins in production", () => {
    process.env.CONTEXT = "production";
    process.env.ALLOWED_ORIGINS = "https://website-internal-test.vercel.app";

    expect(isAllowedBrowserOrigin("https://alphatrack.digital")).toBe(true);
    expect(isAllowedBrowserOrigin("https://www.alphatrack.digital")).toBe(true);
    expect(isAllowedBrowserOrigin("https://website-internal-test.vercel.app")).toBe(false);
    expect(isAllowedBrowserOrigin("https://feature-alphatrackdigitals-projects.vercel.app")).toBe(false);
  });

  it("allows explicitly configured QA origins outside production", () => {
    process.env.CONTEXT = "deploy-preview";
    process.env.ALLOWED_ORIGINS = "https://website-internal-test.vercel.app,http://localhost:8080";

    expect(isAllowedBrowserOrigin("https://website-internal-test.vercel.app")).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:8080")).toBe(true);
    expect(isAllowedBrowserOrigin("https://untrusted.example")).toBe(false);
  });

  it("retains supported preview-host suffixes outside production", () => {
    process.env.CONTEXT = "branch-deploy";

    expect(isAllowedBrowserOrigin("https://feature-alphatrackdigitals-projects.vercel.app")).toBe(true);
    expect(isAllowedBrowserOrigin("https://feature--alphatrackdigital.netlify.app")).toBe(true);
  });

  it("omits Access-Control-Allow-Origin for a rejected production origin", () => {
    process.env.CONTEXT = "production";

    const headers = corsHeaders("https://untrusted.example");
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});
