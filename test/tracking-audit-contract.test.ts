import { describe, expect, it } from "vitest";
import {
  auditLifecycleAttributes,
  normalizeAuditChannels,
  normalizeTrackingAuditApplication,
} from "../api/_lib/trackingAuditContract";

const canonicalPayload = {
  source: "tracking_audit_offer",
  firstName: "Ama",
  lastName: "Mensah",
  email: "ama@example.com",
  company: "Example Co",
  websiteUrl: "https://example.com",
  industry: "professional_services",
  role: "founder_ceo",
  decisionInfluence: "final_decision_maker",
  monthlyAdSpendBand: "6000_14999",
  adPlatforms: ["meta_ads", "google_ads"],
  trackingMaturity: "disconnected",
  primaryConversionType: "lead_form",
  measurementProblem: "conflicting_numbers",
  urgency: "before_scaling",
};

describe("Tracking Audit contract", () => {
  it("normalizes a canonical Ghana Phase 1 application", () => {
    const result = normalizeTrackingAuditApplication(canonicalPayload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("canonical");
    expect(result.value.monthlyAdSpendBand).toBe("6000_14999");
    expect(result.value.adPlatforms).toEqual(["meta_ads", "google_ads"]);
  });

  it("maps known legacy platform labels without translating legacy USD spend into a GHS band", () => {
    const result = normalizeTrackingAuditApplication({
      source: "tracking_audit_offer",
      firstName: "Ama",
      lastName: "Mensah",
      email: "ama@example.com",
      websiteUrl: "https://example.com",
      monthlyAdSpend: "$1k - $5k / mo",
      adPlatforms: "Meta Ads, Google Ads",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("legacy");
    expect(result.value.legacyMonthlyAdSpend).toBe("$1k - $5k / mo");
    expect(result.value.monthlyAdSpendBand).toBe("");
    expect(result.value.adPlatforms).toEqual(["meta_ads", "google_ads"]);
  });

  it("rejects unknown canonical enum values", () => {
    const result = normalizeTrackingAuditApplication({
      ...canonicalPayload,
      industry: "made_up_industry",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("industry");
  });

  it("rejects a canonical-shaped payload missing a required fit field", () => {
    const result = normalizeTrackingAuditApplication({
      ...canonicalPayload,
      urgency: "",
      monthlyAdSpend: "",
    });
    expect(result.ok).toBe(false);
  });

  it("deduplicates channel codes and maps legacy labels", () => {
    expect(normalizeAuditChannels(["meta_ads", "Meta Ads", "Google Ads", "google_ads"])).toEqual([
      "meta_ads",
      "google_ads",
    ]);
  });

  it("initializes canonical applications as Applied with no sales handoff", () => {
    const result = normalizeTrackingAuditApplication(canonicalPayload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attrs = auditLifecycleAttributes(result.value, "2026-08-25T06:30:00.000Z");
    expect(attrs.AUDIT_STATUS).toBe("Applied");
    expect(attrs.AUDIT_HANDOFF_STATUS).toBe("No Sales Handoff");
    expect(attrs.AUDIT_AD_SPEND_BAND).toBe("6000_14999");
    expect(attrs.AUDIT_PAID_CHANNELS).toEqual(["meta_ads", "google_ads"]);
  });

  it("routes legacy applications to Manual Review without fabricating a GHS spend band", () => {
    const result = normalizeTrackingAuditApplication({
      source: "tracking_audit_offer",
      websiteUrl: "https://example.com",
      monthlyAdSpend: "20k+ per month",
      adPlatforms: "Meta Ads",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attrs = auditLifecycleAttributes(result.value, "2026-08-25T06:30:00.000Z");
    expect(attrs.AUDIT_STATUS).toBe("Manual Review");
    expect(attrs.AUDIT_HANDOFF_STATUS).toBe("No Sales Handoff");
    expect(attrs).not.toHaveProperty("AUDIT_AD_SPEND_BAND");
  });
});
