import { createHash } from "node:crypto";
import { buildLeadDedupeKey, getIdempotencyRecord, markIdempotencyKey } from "./idempotency";
import { connectDB } from "./db";
import { Contact } from "./models/Contact";
import {
  auditLifecycleAttributes,
  normalizeTrackingAuditApplication,
  type NormalizedTrackingAuditApplication,
} from "./trackingAuditContract";

interface LeadAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  gclid?: string;
  fbclid?: string;
  fbp?: string;
  fbc?: string;
  landingPage?: string;
  referrer?: string;
}

interface TrackingAuditPayload {
  source: "tracking_audit_offer";
  firstName: string;
  lastName: string;
  email: string;
  optIn?: boolean;
  company?: string;
  websiteUrl?: string;
  industry?: string;
  role?: string;
  decisionInfluence?: string;
  monthlyAdSpend?: string;
  monthlyAdSpendBand?: string;
  adPlatforms?: string | string[];
  trackingMaturity?: string;
  primaryConversionType?: string;
  measurementProblem?: string;
  urgency?: string;
  websiteRoute?: string;
  route?: string;
  pagePath?: string;
  attribution?: LeadAttribution;
  metaEventId?: string;
}

interface Req {
  method?: string;
  body?: TrackingAuditPayload;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

interface Res {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

type BrevoAttributeValue = string | boolean | string[];
type BrevoContact = { id?: number | string; attributes?: Record<string, unknown> };

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 8;
const requestBuckets = new Map<string, { count: number; windowStart: number }>();

const allowedHostnames = new Set([
  "alphatrack.digital",
  "www.alphatrack.digital",
  "alphatrackdigital.com",
  "www.alphatrackdigital.com",
  "alphatrackdigital.netlify.app",
  "alphatra-serv.netlify.app",
  "backend--alphatra-serv.netlify.app",
  "website-internal-test.vercel.app",
  "atd-website-test.vercel.app",
  "atd-website-test-alphatrackdigitals-projects.vercel.app",
]);

const isAllowedOrigin = (origin?: string) => {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    if (allowedHostnames.has(url.hostname)) return true;
    return (
      url.hostname.endsWith("-alphatrackdigitals-projects.vercel.app") ||
      url.hostname.endsWith("--alphatrackdigital.netlify.app")
    );
  } catch {
    return false;
  }
};

const setCorsHeaders = (req: Req, res: Res) => {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
};

const getClientIp = (req: Req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (Array.isArray(forwarded)) return forwarded[0] || "unknown";
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
};

const isRateLimited = (key: string) => {
  const now = Date.now();
  const existing = requestBuckets.get(key);
  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    requestBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  existing.count += 1;
  requestBuckets.set(key, existing);
  return existing.count > RATE_LIMIT_MAX_REQUESTS;
};

const getHeader = (headers: Req["headers"], name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const truncateAttribute = (value: unknown, maxLength = 500) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const normalizeRoute = (value?: string) => {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.pathname || "/";
  } catch {
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
};

const getSubmittedRoute = (data: TrackingAuditPayload) =>
  normalizeRoute(data.websiteRoute) ||
  normalizeRoute(data.route) ||
  normalizeRoute(data.pagePath) ||
  "/offer/tracking-audit";

const getAttributionAttributes = (data: TrackingAuditPayload): Record<string, string> => {
  const attribution = data.attribution && typeof data.attribution === "object" ? data.attribution : {};
  return Object.fromEntries(
    [
      ["UTM_SOURCE", truncateAttribute(attribution.utmSource)],
      ["UTM_MEDIUM", truncateAttribute(attribution.utmMedium)],
      ["UTM_CAMPAIGN", truncateAttribute(attribution.utmCampaign)],
      ["UTM_CONTENT", truncateAttribute(attribution.utmContent)],
      ["UTM_TERM", truncateAttribute(attribution.utmTerm)],
      ["GCLID", truncateAttribute(attribution.gclid)],
      ["FBCLID", truncateAttribute(attribution.fbclid)],
      ["LANDING_PAGE", truncateAttribute(attribution.landingPage)],
      ["REFERRER", truncateAttribute(attribution.referrer)],
    ].filter(([, value]) => value.length > 0),
  );
};

const getStringAttribute = (contact: BrevoContact | undefined, name: string) => {
  const value = contact?.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
};

const getSourceLifecycleAttributes = (
  data: TrackingAuditPayload,
  existingContact: BrevoContact | undefined,
  timestamp: string,
): Record<string, string> => {
  const currentSource = "Tracking Audit Landing Page";
  const currentLeadSource = "tracking_audit_offer";
  const existingSource = getStringAttribute(existingContact, "SOURCE");
  const existingLeadSource = getStringAttribute(existingContact, "LEAD_SOURCE");
  const previousHistory = getStringAttribute(existingContact, "SOURCE_HISTORY");
  const historyEntry = `${timestamp} | ${currentSource} | ${currentLeadSource} | ${getSubmittedRoute(data)}`;
  const sourceHistory = [previousHistory, historyEntry].filter(Boolean).join("\n").slice(-2000);

  return {
    SOURCE: currentSource,
    LAST_SOURCE: currentSource,
    LAST_LEAD_SOURCE: currentLeadSource,
    LAST_SOURCE_TIMESTAMP: timestamp,
    FIRST_SOURCE: getStringAttribute(existingContact, "FIRST_SOURCE") || existingSource || currentSource,
    FIRST_LEAD_SOURCE:
      getStringAttribute(existingContact, "FIRST_LEAD_SOURCE") || existingLeadSource || currentLeadSource,
    FIRST_SOURCE_TIMESTAMP: getStringAttribute(existingContact, "FIRST_SOURCE_TIMESTAMP") || timestamp,
    SOURCE_HISTORY: sourceHistory,
  };
};

const buildBrevoAttributes = (
  data: TrackingAuditPayload,
  audit: NormalizedTrackingAuditApplication,
  existingContact?: BrevoContact,
): Record<string, BrevoAttributeValue> => {
  const timestamp = new Date().toISOString();
  const attributes: Record<string, BrevoAttributeValue> = {
    FIRSTNAME: data.firstName.trim(),
    LASTNAME: data.lastName.trim(),
    ...(audit.company ? { COMPANY: audit.company } : {}),
    WEBSITE: audit.websiteUrl,
    AD_PLATFORMS: audit.adPlatforms.join(", "),
    ...(audit.mode === "legacy" ? { AD_SPEND: audit.legacyMonthlyAdSpend } : {}),
    ...auditLifecycleAttributes(audit, timestamp),
    LEAD_SOURCE: "tracking_audit_offer",
    ...getSourceLifecycleAttributes(data, existingContact, timestamp),
    WEBSITE_ROUTE: getSubmittedRoute(data),
    OFFER: "tracking-audit",
    CONSENT_STATUS: data.optIn === true ? "opted_in" : "not_provided",
    CONSENT_TIMESTAMP: timestamp,
    ...getAttributionAttributes(data),
  };

  if (data.optIn === true) {
    attributes.OPT_IN = true;
    const consentAttribute = process.env.BREVO_CONSENT_ATTRIBUTE?.trim();
    const consentTimestampAttribute = process.env.BREVO_CONSENT_TIMESTAMP_ATTRIBUTE?.trim();
    if (consentAttribute) attributes[consentAttribute] = "Yes";
    if (consentTimestampAttribute) attributes[consentTimestampAttribute] = timestamp;
  }

  return attributes;
};

const getBrevoContactByEmail = async (email: string, apiKey: string): Promise<BrevoContact | undefined> => {
  const response = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { "api-key": apiKey },
  });
  if (!response.ok) return undefined;
  return await response.json().catch(() => undefined) as BrevoContact | undefined;
};

const upsertBrevoContact = async (
  data: TrackingAuditPayload,
  audit: NormalizedTrackingAuditApplication,
  existingContact: BrevoContact | undefined,
  listId: number,
  apiKey: string,
) => {
  const response = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      email: data.email.trim(),
      attributes: buildBrevoAttributes(data, audit, existingContact),
      listIds: [listId],
      updateEnabled: true,
    }),
  });

  if (!response.ok) return { ok: false as const, status: response.status };
  const created = await response.clone().json().catch(() => ({})) as { id?: number | string };
  const contactId = created.id || existingContact?.id || (await getBrevoContactByEmail(data.email, apiKey))?.id;
  return { ok: true as const, contactId };
};

const getNextBusinessDayIso = () => {
  const dueDate = new Date();
  dueDate.setUTCDate(dueDate.getUTCDate() + 1);
  dueDate.setUTCHours(10, 0, 0, 0);
  const day = dueDate.getUTCDay();
  if (day === 6) dueDate.setUTCDate(dueDate.getUTCDate() + 2);
  if (day === 0) dueDate.setUTCDate(dueDate.getUTCDate() + 1);
  return dueDate.toISOString();
};

const crmConfig = {
  ownerId: "68bf7b64faf0e9c68b0ccdb4",
  taskTypeId: "68bf7ba1f6e11688cf7a215e",
};

const createAuditReviewTask = async (
  data: TrackingAuditPayload,
  audit: NormalizedTrackingAuditApplication,
  contactId: number | string | undefined,
  apiKey: string,
) => {
  if (!contactId) return;
  const label = audit.websiteUrl || audit.company || data.email;
  const notes = audit.mode === "legacy"
    ? "Legacy pre-v1.0 Tracking Audit application. Manual Review required for fit, scope, and structured qualification fields."
    : "Tracking Audit application received. Review fit, scope, and submitted qualification fields within 1 business day. Do not create a Deal unless a genuine sales Opportunity is established.";
  const response = await fetch("https://api.brevo.com/v3/crm/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      name: `Review tracking audit application - ${label}`,
      date: getNextBusinessDayIso(),
      taskTypeId: crmConfig.taskTypeId,
      assignToId: crmConfig.ownerId,
      contactsIds: [Number(contactId)],
      dealsIds: [],
      notes,
      done: false,
    }),
  });
  if (!response.ok) throw new Error(`Brevo CRM task creation failed with status ${response.status}.`);
};

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const auditRows = (data: TrackingAuditPayload, audit: NormalizedTrackingAuditApplication) => [
  ["Source", "Tracking Audit Landing Page"],
  ["Name", `${data.firstName} ${data.lastName}`.trim()],
  ["Email", data.email],
  ["Company", audit.company],
  ["Website", audit.websiteUrl],
  ["Industry", audit.industry],
  ["Role", audit.role],
  ["Decision influence", audit.decisionInfluence],
  ["Monthly ad spend band", audit.monthlyAdSpendBand],
  ["Legacy monthly ad spend", audit.legacyMonthlyAdSpend],
  ["Paid channels", audit.adPlatforms.join(", ")],
  ["Tracking maturity", audit.trackingMaturity],
  ["Primary conversion", audit.primaryConversionType],
  ["Measurement problem", audit.measurementProblem],
  ["Urgency", audit.urgency],
  ["Audit status", audit.mode === "canonical" ? "Applied" : "Manual Review"],
  ["UTM Source", data.attribution?.utmSource || ""],
  ["UTM Medium", data.attribution?.utmMedium || ""],
  ["UTM Campaign", data.attribution?.utmCampaign || ""],
  ["UTM Content", data.attribution?.utmContent || ""],
  ["Landing Page", data.attribution?.landingPage || ""],
  ["Marketing opt-in", data.optIn === true ? "Yes" : "No"],
].filter(([, value]) => String(value || "").trim().length > 0);

const sendInternalNotification = async (
  data: TrackingAuditPayload,
  audit: NormalizedTrackingAuditApplication,
  apiKey: string,
) => {
  const rows = auditRows(data, audit);
  const textContent = ["Tracking audit application", "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const htmlRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(value)}</td>
    </tr>`).join("");
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      sender: { name: "AlphaTrack Digital", email: "audit@alphatrack.digital" },
      to: [{ email: "audit@alphatrack.digital" }, { email: "martech@alphatrack.digital" }],
      replyTo: { email: "audit@alphatrack.digital", name: "AlphaTrack Digital" },
      subject: "New tracking audit application",
      htmlContent: `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;"><h1 style="font-size:20px;">Tracking audit application</h1><table role="presentation" style="border-collapse:collapse;width:100%;max-width:720px;border:1px solid #e5e7eb;">${htmlRows}</table></div>`,
      textContent,
      tags: ["tracking_audit_offer"],
    }),
  });
  if (!response.ok) throw new Error(`Tracking Audit internal notification failed with status ${response.status}.`);
};

const sendApplicantReceipt = async (data: TrackingAuditPayload, apiKey: string) => {
  const firstName = data.firstName.trim();
  const textContent = `Hi ${firstName},\n\nWe’ve received your Free Conversion Tracking Audit application.\n\nWe’ll review the information you submitted for fit and scope. If we need additional evidence, we’ll contact you with the safest next step. Please do not send passwords or admin credentials.\n\nThis message confirms receipt of your application. It does not mean the audit has been accepted yet.\n\nAlphaTrack Digital`;
  const htmlContent = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.6;"><p>Hi ${escapeHtml(firstName)},</p><p>We’ve received your Free Conversion Tracking Audit application.</p><p>We’ll review the information you submitted for fit and scope. If we need additional evidence, we’ll contact you with the safest next step. Please do not send passwords or admin credentials.</p><p>This message confirms receipt of your application. It does not mean the audit has been accepted yet.</p><p>AlphaTrack Digital</p></div>`;
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      sender: { name: "AlphaTrack Digital", email: "audit@alphatrack.digital" },
      to: [{ email: data.email.trim(), name: `${data.firstName} ${data.lastName}`.trim() }],
      replyTo: { email: "audit@alphatrack.digital", name: "AlphaTrack Digital" },
      subject: "We received your Tracking Audit application",
      htmlContent,
      textContent,
      tags: ["tracking_audit_receipt"],
    }),
  });
  if (!response.ok) throw new Error(`Tracking Audit applicant receipt failed with status ${response.status}.`);
};

const sha256 = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

const getMetaEventSourceUrl = (data: TrackingAuditPayload) => {
  const route = getSubmittedRoute(data);
  try {
    return new URL(data.attribution?.landingPage || route, "https://alphatrack.digital").toString();
  } catch {
    return `https://alphatrack.digital${route}`;
  }
};

const sendMetaConversionEvent = async (data: TrackingAuditPayload, req: Req) => {
  const pixelId = process.env.META_PIXEL_ID?.trim();
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN?.trim();
  if (!pixelId || !accessToken) {
    console.info("Meta CAPI is not configured; skipping lead event.", { source: data.source });
    return;
  }

  const graphVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v23.0";
  const testEventCode = process.env.META_CAPI_TEST_EVENT_CODE?.trim();
  const eventId = data.metaEventId || buildLeadDedupeKey(data as unknown as Record<string, unknown>);
  const userAgent = getHeader(req.headers, "user-agent") || "";
  const clientIp = getClientIp(req);
  const body = {
    data: [{
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: "website",
      event_source_url: getMetaEventSourceUrl(data),
      user_data: {
        em: [sha256(data.email)],
        fn: [sha256(data.firstName)],
        ln: [sha256(data.lastName)],
        ...(data.attribution?.fbp ? { fbp: data.attribution.fbp } : {}),
        ...(data.attribution?.fbc ? { fbc: data.attribution.fbc } : {}),
        ...(clientIp !== "unknown" ? { client_ip_address: clientIp } : {}),
        ...(userAgent ? { client_user_agent: userAgent } : {}),
      },
      custom_data: {
        lead_source: "tracking_audit_offer",
        content_name: "Tracking Audit Landing Page",
        website_route: getSubmittedRoute(data),
        ...(data.attribution?.utmSource ? { utm_source: data.attribution.utmSource } : {}),
        ...(data.attribution?.utmCampaign ? { utm_campaign: data.attribution.utmCampaign } : {}),
        ...(data.attribution?.fbclid ? { fbclid: data.attribution.fbclid } : {}),
      },
    }],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };

  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!response.ok) throw new Error(`Meta CAPI rejected the Tracking Audit lead event with status ${response.status}.`);
};

const saveAuditToMongoDB = async (
  data: TrackingAuditPayload,
  audit: NormalizedTrackingAuditApplication,
  ip: string,
) => {
  if (!process.env.MONGODB_URI) return;
  try {
    await connectDB();
    await Contact.create({
      source: "tracking_audit_offer",
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      company: audit.company,
      websiteUrl: audit.websiteUrl,
      monthlyAdSpend: audit.mode === "legacy" ? audit.legacyMonthlyAdSpend : "",
      legacyMonthlyAdSpend: audit.legacyMonthlyAdSpend,
      monthlyAdSpendBand: audit.monthlyAdSpendBand,
      adPlatforms: audit.adPlatforms.join(", "),
      industry: audit.industry,
      role: audit.role,
      decisionInfluence: audit.decisionInfluence,
      trackingMaturity: audit.trackingMaturity,
      primaryConversionType: audit.primaryConversionType,
      measurementProblem: audit.measurementProblem,
      urgency: audit.urgency,
      ip,
    });
  } catch (error) {
    console.error("[tracking-audit] MongoDB save error (non-fatal):", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const logNonFatal = (label: string, error: unknown) => {
  console.error(label, { message: error instanceof Error ? error.message : String(error) });
};

const runIdempotentAuditStep = async (
  dedupeKey: string,
  step: string,
  action: () => Promise<void>,
  errorLabel: string,
) => {
  const stepKey = `${dedupeKey}/${step}`;
  if (await getIdempotencyRecord(stepKey)) return;

  try {
    await action();
    await markIdempotencyKey(stepKey, { completed: true });
  } catch (error) {
    logNonFatal(errorLabel, error);
  }
};

const completeAuditSideEffects = async (
  dedupeKey: string,
  data: TrackingAuditPayload,
  audit: NormalizedTrackingAuditApplication,
  contactId: number | string | undefined,
  brevoApiKey: string,
  req: Req,
) => {
  let resolvedContactId = contactId;
  const taskKey = `${dedupeKey}/audit-review-task`;
  if (!(await getIdempotencyRecord(taskKey)) && !resolvedContactId) {
    resolvedContactId = (await getBrevoContactByEmail(data.email, brevoApiKey))?.id;
  }

  await runIdempotentAuditStep(
    dedupeKey,
    "audit-review-task",
    async () => {
      if (!resolvedContactId) throw new Error("Brevo contact ID is unavailable for Tracking Audit review task.");
      await createAuditReviewTask(data, audit, resolvedContactId, brevoApiKey);
    },
    "Brevo Tracking Audit review task failed after successful capture",
  );
  await runIdempotentAuditStep(
    dedupeKey,
    "audit-internal-alert",
    () => sendInternalNotification(data, audit, brevoApiKey),
    "Tracking Audit internal notification failed after successful capture",
  );
  await runIdempotentAuditStep(
    dedupeKey,
    "audit-applicant-receipt",
    () => sendApplicantReceipt(data, brevoApiKey),
    "Tracking Audit applicant receipt failed after successful capture",
  );
  await runIdempotentAuditStep(
    dedupeKey,
    "audit-meta-capi",
    () => sendMetaConversionEvent(data, req),
    "Meta CAPI Tracking Audit lead event failed after successful capture",
  );
};

const trackingAuditHandler = async (req: Req, res: Res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).json({});
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, message: "Too many requests. Please try again shortly." });
  }

  const payload = req.body;
  if (!payload || payload.source !== "tracking_audit_offer" || !payload.email?.trim() || !payload.firstName?.trim() || !payload.lastName?.trim()) {
    return res.status(400).json({ ok: false, message: "Invalid submission payload." });
  }

  const normalized = normalizeTrackingAuditApplication(payload);
  if (!normalized.ok) {
    return res.status(400).json({ ok: false, message: "Invalid submission payload." });
  }
  const audit = normalized.value;

  const brevoApiKey = process.env.BREVO_API_KEY?.trim();
  const auditListId = Number(process.env.BREVO_AUDIT_LIST_ID || "11");
  if (!brevoApiKey) {
    return res.status(500).json({ ok: false, message: "Lead service is not configured." });
  }

  const dedupeKey = buildLeadDedupeKey(payload as unknown as Record<string, unknown>);
  const existingSubmission = await getIdempotencyRecord(dedupeKey);
  const isDuplicate = Boolean(existingSubmission);
  if (isDuplicate) {
    const storedContactId = existingSubmission?.contactId;
    const contactId = typeof storedContactId === "string" || typeof storedContactId === "number"
      ? storedContactId
      : undefined;
    await completeAuditSideEffects(dedupeKey, payload, audit, contactId, brevoApiKey, req);
    return res.status(200).json({ ok: true, pendingConfirmation: false, duplicate: true, metaEventId: payload.metaEventId });
  }

  try {
    const existingBrevoContact = await getBrevoContactByEmail(payload.email, brevoApiKey);
    const upsert = await upsertBrevoContact(payload, audit, existingBrevoContact, auditListId, brevoApiKey);
    if (!upsert.ok) {
      console.error("Brevo Tracking Audit capture failed", { listId: auditListId, status: upsert.status });
      return res.status(502).json({ ok: false, message: "Unable to submit lead right now." });
    }

    await markIdempotencyKey(dedupeKey, {
      source: payload.source,
      emailHash: dedupeKey.split("/").at(-1),
      listId: auditListId,
      auditMode: audit.mode,
      ...(upsert.contactId ? { contactId: upsert.contactId } : {}),
    });

    await saveAuditToMongoDB(payload, audit, ip);
    await completeAuditSideEffects(dedupeKey, payload, audit, upsert.contactId, brevoApiKey, req);

    return res.status(200).json({ ok: true, pendingConfirmation: false, duplicate: false, metaEventId: payload.metaEventId });
  } catch (error) {
    console.error("Tracking Audit submission failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ ok: false, message: "Unable to submit lead right now." });
  }
};

export default trackingAuditHandler;
