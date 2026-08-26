import type { VercelRequest, VercelResponse } from "@vercel/node";
import trackingAuditHandler from "./_lib/trackingAuditHandler";

const QA_EMAIL = "qa-tracking-audit-20260826-1554@alphatrack.digital";
const QA_WEBSITE = "https://alphatrack.digital/qa/tracking-audit-e2e-20260826-1554";
const QA_EVENT_ID = "atd-qa-tracking-audit-20260826-1554";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false });
  }

  let statusCode = 200;
  let responseBody: unknown = null;
  const mockRes = {
    setHeader: (_name: string, _value: string) => undefined,
    status(code: number) {
      statusCode = code;
      return mockRes;
    },
    json(payload: unknown) {
      responseBody = payload;
    },
  };

  await trackingAuditHandler(
    {
      method: "POST",
      body: {
        source: "tracking_audit_offer",
        firstName: "ATD",
        lastName: "QA",
        email: QA_EMAIL,
        optIn: false,
        company: "AlphaTrack Digital QA",
        websiteUrl: QA_WEBSITE,
        industry: "professional_services",
        role: "founder_ceo",
        decisionInfluence: "final_decision_maker",
        monthlyAdSpendBand: "under_1500",
        adPlatforms: ["meta_ads", "google_ads"],
        trackingMaturity: "partial",
        primaryConversionType: "lead_form",
        measurementProblem: "missing_conversion_tracking",
        urgency: "before_scaling",
        websiteRoute: "/offer/tracking-audit",
        attribution: {
          utmSource: "atd_qa",
          utmMedium: "staging_e2e",
          utmCampaign: "tracking_audit_release_qa",
          utmContent: "canonical_application",
          landingPage: "https://alphatrack.digital/offer/tracking-audit?utm_source=atd_qa",
          referrer: "https://alphatrack.digital/",
        },
        metaEventId: QA_EVENT_ID,
      },
      headers: {
        origin: "https://alphatrack.digital",
        "user-agent": "ATD-Tracking-Audit-QA/1.0",
        "x-forwarded-for": "203.0.113.26",
      },
      socket: { remoteAddress: "203.0.113.26" },
    },
    mockRes,
  );

  return res.status(statusCode).json({
    qaEmail: QA_EMAIL,
    qaWebsite: QA_WEBSITE,
    result: responseBody,
  });
}
