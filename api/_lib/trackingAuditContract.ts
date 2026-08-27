export const AUDIT_INDUSTRIES = [
  "professional_services",
  "education_training",
  "ecommerce_dtc",
  "real_estate",
  "other",
] as const;

export const AUDIT_ROLES = [
  "founder_ceo",
  "marketing_lead",
  "growth_performance",
  "operations_commercial",
  "other",
] as const;

export const AUDIT_DECISION_INFLUENCE = [
  "final_decision_maker",
  "strong_influence",
  "contributor",
  "researching",
] as const;

export const AUDIT_AD_SPEND_BANDS = [
  "paused_or_not_spending",
  "under_1500",
  "1500_2999",
  "3000_5999",
  "6000_14999",
  "15000_plus",
  "not_sure",
] as const;

export const AUDIT_PAID_CHANNELS = [
  "meta_ads",
  "google_ads",
  "microsoft_ads",
  "linkedin_ads",
  "tiktok_ads",
  "other",
  "none_currently",
] as const;

export const AUDIT_TRACKING_MATURITY = ["not_sure", "basic", "partial", "disconnected", "confident"] as const;
export const AUDIT_PRIMARY_CONVERSIONS = [
  "lead_form",
  "booked_call_appointment",
  "whatsapp_message",
  "ecommerce_purchase",
  "application_enrolment",
  "other",
] as const;
export const AUDIT_MEASUREMENT_PROBLEMS = [
  "unclear_campaign_performance",
  "conflicting_numbers",
  "missing_conversion_tracking",
  "leads_without_attribution",
  "browser_server_signal_gap",
  "other",
] as const;
export const AUDIT_URGENCY = ["before_scaling", "within_30_days", "one_to_three_months", "exploring"] as const;

export type AuditApplicationMode = "canonical" | "legacy";

export interface NormalizedTrackingAuditApplication {
  mode: AuditApplicationMode;
  company: string;
  websiteUrl: string;
  industry: string;
  role: string;
  decisionInfluence: string;
  monthlyAdSpendBand: string;
  legacyMonthlyAdSpend: string;
  adPlatforms: string[];
  trackingMaturity: string;
  primaryConversionType: string;
  measurementProblem: string;
  urgency: string;
}

const asTrimmedString = (value: unknown) => typeof value === "string" ? value.trim() : "";
const unique = <T>(values: T[]) => [...new Set(values)];

const LEGACY_CHANNEL_MAP: Record<string, string> = {
  "Meta Ads": "meta_ads",
  "Google Ads": "google_ads",
  "Microsoft Ads": "microsoft_ads",
  "LinkedIn Ads": "linkedin_ads",
  "TikTok Ads": "tiktok_ads",
  Other: "other",
  "None currently": "none_currently",
};

const canonicalSet = (values: readonly string[]) => new Set<string>(values);
const INDUSTRIES = canonicalSet(AUDIT_INDUSTRIES);
const ROLES = canonicalSet(AUDIT_ROLES);
const DECISIONS = canonicalSet(AUDIT_DECISION_INFLUENCE);
const SPEND_BANDS = canonicalSet(AUDIT_AD_SPEND_BANDS);
const CHANNELS = canonicalSet(AUDIT_PAID_CHANNELS);
const MATURITY = canonicalSet(AUDIT_TRACKING_MATURITY);
const CONVERSIONS = canonicalSet(AUDIT_PRIMARY_CONVERSIONS);
const PROBLEMS = canonicalSet(AUDIT_MEASUREMENT_PROBLEMS);
const URGENCY = canonicalSet(AUDIT_URGENCY);

const rawAuditChannels = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]+/) : [];
  return raw.map((item) => asTrimmedString(item)).filter(Boolean);
};

const normalizeAuditChannel = (item: string): string =>
  CHANNELS.has(item) ? item : LEGACY_CHANNEL_MAP[item] || "";

export const normalizeAuditChannels = (value: unknown): string[] =>
  unique(rawAuditChannels(value).map(normalizeAuditChannel).filter(Boolean));

const unknownAuditChannels = (value: unknown): string[] =>
  rawAuditChannels(value).filter((item) => !normalizeAuditChannel(item));

const CANONICAL_ONLY_FIELDS = [
  "industry",
  "role",
  "decisionInfluence",
  "monthlyAdSpendBand",
  "trackingMaturity",
  "primaryConversionType",
  "measurementProblem",
  "urgency",
] as const;

const hasCanonicalShape = (data: Record<string, unknown>) =>
  CANONICAL_ONLY_FIELDS.some((key) => asTrimmedString(data[key]).length > 0) ||
  SPEND_BANDS.has(asTrimmedString(data.monthlyAdSpend)) ||
  rawAuditChannels(data.adPlatforms).some((item) => CHANNELS.has(item));

export const normalizeTrackingAuditApplication = (
  input: unknown,
): { ok: true; value: NormalizedTrackingAuditApplication } | { ok: false; errors: string[] } => {
  if (!input || typeof input !== "object") return { ok: false, errors: ["invalid_payload"] };
  const data = input as Record<string, unknown>;
  const websiteUrl = asTrimmedString(data.websiteUrl);
  const company = asTrimmedString(data.company);
  const channels = normalizeAuditChannels(data.adPlatforms);
  const invalidChannels = unknownAuditChannels(data.adPlatforms);
  const canonical = hasCanonicalShape(data);

  if (!websiteUrl) return { ok: false, errors: ["websiteUrl"] };

  if (!canonical) {
    const legacySpend = asTrimmedString(data.monthlyAdSpend);
    if (!legacySpend || channels.length === 0) {
      return {
        ok: false,
        errors: [!legacySpend ? "monthlyAdSpend" : "", channels.length === 0 ? "adPlatforms" : ""].filter(Boolean),
      };
    }
    return {
      ok: true,
      value: {
        mode: "legacy",
        company,
        websiteUrl,
        industry: "",
        role: "",
        decisionInfluence: "",
        monthlyAdSpendBand: "",
        legacyMonthlyAdSpend: legacySpend,
        adPlatforms: channels,
        trackingMaturity: "",
        primaryConversionType: "",
        measurementProblem: "",
        urgency: "",
      },
    };
  }

  const industry = asTrimmedString(data.industry);
  const role = asTrimmedString(data.role);
  const decisionInfluence = asTrimmedString(data.decisionInfluence);
  const monthlyAdSpendBand = asTrimmedString(data.monthlyAdSpendBand) || asTrimmedString(data.monthlyAdSpend);
  const trackingMaturity = asTrimmedString(data.trackingMaturity);
  const primaryConversionType = asTrimmedString(data.primaryConversionType);
  const measurementProblem = asTrimmedString(data.measurementProblem);
  const urgency = asTrimmedString(data.urgency);
  const errors = [
    !company ? "company" : "",
    !INDUSTRIES.has(industry) ? "industry" : "",
    !ROLES.has(role) ? "role" : "",
    !DECISIONS.has(decisionInfluence) ? "decisionInfluence" : "",
    !SPEND_BANDS.has(monthlyAdSpendBand) ? "monthlyAdSpendBand" : "",
    channels.length === 0 || invalidChannels.length > 0 ? "adPlatforms" : "",
    !MATURITY.has(trackingMaturity) ? "trackingMaturity" : "",
    !CONVERSIONS.has(primaryConversionType) ? "primaryConversionType" : "",
    !PROBLEMS.has(measurementProblem) ? "measurementProblem" : "",
    !URGENCY.has(urgency) ? "urgency" : "",
  ].filter(Boolean);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      mode: "canonical",
      company,
      websiteUrl,
      industry,
      role,
      decisionInfluence,
      monthlyAdSpendBand,
      legacyMonthlyAdSpend: "",
      adPlatforms: channels,
      trackingMaturity,
      primaryConversionType,
      measurementProblem,
      urgency,
    },
  };
};

export const auditLifecycleAttributes = (
  audit: NormalizedTrackingAuditApplication,
  timestamp: string,
): Record<string, string | string[]> => ({
  ...(audit.company ? { COMPANY: audit.company } : {}),
  WEBSITE_URL: audit.websiteUrl,
  AUDIT_INDUSTRY: audit.mode === "canonical" ? audit.industry : "",
  AUDIT_ROLE: audit.mode === "canonical" ? audit.role : "",
  AUDIT_DECISION_INFLUENCE: audit.mode === "canonical" ? audit.decisionInfluence : "",
  AUDIT_AD_SPEND_BAND: audit.mode === "canonical" ? audit.monthlyAdSpendBand : "",
  ...(audit.adPlatforms.length ? { AUDIT_PAID_CHANNELS: audit.adPlatforms } : {}),
  AUDIT_TRACKING_MATURITY: audit.mode === "canonical" ? audit.trackingMaturity : "",
  AUDIT_PRIMARY_CONVERSION: audit.mode === "canonical" ? audit.primaryConversionType : "",
  AUDIT_MEASUREMENT_PROBLEM: audit.mode === "canonical" ? audit.measurementProblem : "",
  AUDIT_URGENCY: audit.mode === "canonical" ? audit.urgency : "",
  AUDIT_STATUS: audit.mode === "canonical" ? "Applied" : "Manual Review",
  AUDIT_HANDOFF_STATUS: "No Sales Handoff",
  AUDIT_APPLIED_AT: timestamp,
  AUDIT_LEGACY_AD_SPEND: audit.mode === "legacy" ? audit.legacyMonthlyAdSpend : "",
  AUDIT_REVIEW_OUTCOME: audit.mode === "legacy" ? "Manual Review" : "",
  AUDIT_REVIEW_RATIONALE:
    audit.mode === "legacy"
      ? "Legacy pre-v1.0 Tracking Audit application payload; structured qualification fields require review."
      : "",
});