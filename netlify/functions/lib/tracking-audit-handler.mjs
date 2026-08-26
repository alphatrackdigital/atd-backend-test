import { createHash } from "node:crypto";
import {
  buildLeadDedupeKey,
  claimAuditStep,
  completeAuditStep,
  getIdempotencyRecord,
  markIdempotencyKey,
  releaseAuditStep,
} from "./idempotency.mjs";
import { saveLeadContact } from "./contact-persistence.mjs";
import { hasDisallowedBrowserOrigin, isAllowedBrowserOrigin } from "./origin-policy.mjs";
import { auditLifecycleAttributes, normalizeTrackingAuditApplication } from "./tracking-audit-contract.mjs";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 8;
const buckets = globalThis.__atdTrackingAuditRequestBuckets ?? new Map();
globalThis.__atdTrackingAuditRequestBuckets = buckets;

const json = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(init.headers ?? {}) },
  });

const getEnv = (name) => {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  if (typeof process !== "undefined") return process.env[name];
  return undefined;
};

const getCorsHeaders = (request) => {
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  };
  if (isAllowedBrowserOrigin(origin, getEnv("CONTEXT"), getEnv("ALLOWED_ORIGINS"))) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return headers;
};

const getClientIp = (request) =>
  request.headers.get("x-nf-client-connection-ip") ||
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("client-ip") ||
  "unknown";

const isRateLimited = (key) => {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  existing.count += 1;
  buckets.set(key, existing);
  return existing.count > RATE_LIMIT_MAX_REQUESTS;
};

const truncateAttribute = (value, maxLength = 500) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const normalizeRoute = (value) => {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.pathname || "/";
  } catch {
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
};

const getSubmittedRoute = (data) =>
  normalizeRoute(data.websiteRoute) ||
  normalizeRoute(data.route) ||
  normalizeRoute(data.pagePath) ||
  "/offer/tracking-audit";

const getAttributionAttributes = (data) => {
  const attribution = data.attribution && typeof data.attribution === "object" ? data.attribution : {};
  return Object.fromEntries([
    ["UTM_SOURCE", truncateAttribute(attribution.utmSource)],
    ["UTM_MEDIUM", truncateAttribute(attribution.utmMedium)],
    ["UTM_CAMPAIGN", truncateAttribute(attribution.utmCampaign)],
    ["UTM_CONTENT", truncateAttribute(attribution.utmContent)],
    ["UTM_TERM", truncateAttribute(attribution.utmTerm)],
    ["GCLID", truncateAttribute(attribution.gclid)],
    ["FBCLID", truncateAttribute(attribution.fbclid)],
    ["LANDING_PAGE", truncateAttribute(attribution.landingPage)],
    ["REFERRER", truncateAttribute(attribution.referrer)],
  ].filter(([, value]) => value.length > 0));
};

const getStringAttribute = (contact, name) => {
  const value = contact?.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
};

const getSourceLifecycleAttributes = (data, existingContact, timestamp) => {
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
    FIRST_LEAD_SOURCE: getStringAttribute(existingContact, "FIRST_LEAD_SOURCE") || existingLeadSource || currentLeadSource,
    FIRST_SOURCE_TIMESTAMP: getStringAttribute(existingContact, "FIRST_SOURCE_TIMESTAMP") || timestamp,
    SOURCE_HISTORY: sourceHistory,
  };
};

const buildBrevoAttributes = (data, audit, existingContact) => {
  const timestamp = new Date().toISOString();
  const attributes = {
    FIRSTNAME: data.firstName.trim(),
    LASTNAME: data.lastName.trim(),
    ...(audit.company ? { COMPANY: audit.company } : {}),
    WEBSITE: audit.websiteUrl,
    AD_PLATFORMS: audit.adPlatforms.join(", "),
    AD_SPEND: audit.mode === "legacy" ? audit.legacyMonthlyAdSpend : "",
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
    const consentAttribute = getEnv("BREVO_CONSENT_ATTRIBUTE")?.trim();
    const consentTimestampAttribute = getEnv("BREVO_CONSENT_TIMESTAMP_ATTRIBUTE")?.trim();
    if (consentAttribute) attributes[consentAttribute] = "Yes";
    if (consentTimestampAttribute) attributes[consentTimestampAttribute] = timestamp;
  }
  return attributes;
};

const getBrevoContactByEmail = async (email, apiKey) => {
  const response = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { "api-key": apiKey },
  });
  if (!response.ok) return undefined;
  return response.json().catch(() => undefined);
};

const upsertBrevoContact = async (data, audit, existingContact, listId, apiKey) => {
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
  if (!response.ok) return { ok: false, status: response.status };
  const created = await response.clone().json().catch(() => ({}));
  const contactId = created.id || existingContact?.id || (await getBrevoContactByEmail(data.email, apiKey))?.id;
  return { ok: true, contactId };
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

const createAuditReviewTask = async (data, audit, contactId, apiKey) => {
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

const escapeHtml = (value) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const auditRows = (data, audit) => [
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

const sendInternalNotification = async (data, audit, apiKey) => {
  const rows = auditRows(data, audit);
  const textContent = ["Tracking audit application", "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const htmlRows = rows.map(([label, value]) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(value)}</td></tr>`).join("");
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

const sendApplicantReceipt = async (data, apiKey) => {
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

const sha256 = (value) => createHash("sha256").update(String(value || "").trim().toLowerCase()).digest("hex");

const getMetaEventSourceUrl = (data) => {
  const route = getSubmittedRoute(data);
  try {
    return new URL(data.attribution?.landingPage || route, "https://alphatrack.digital").toString();
  } catch {
    return `https://alphatrack.digital${route}`;
  }
};

const sendMetaConversionEvent = async (data, request) => {
  const pixelId = getEnv("META_PIXEL_ID")?.trim();
  const accessToken = getEnv("META_CAPI_ACCESS_TOKEN")?.trim();
  if (!pixelId || !accessToken) {
    console.info("Meta CAPI is not configured; skipping lead event.", { source: data.source });
    return;
  }
  const graphVersion = getEnv("META_GRAPH_API_VERSION")?.trim() || "v23.0";
  const testEventCode = getEnv("META_CAPI_TEST_EVENT_CODE")?.trim();
  const eventId = data.metaEventId || buildLeadDedupeKey(data);
  const clientIp = getClientIp(request);
  const userAgent = request.headers.get("user-agent") || "";
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

const logNonFatal = (label, error) => {
  console.error(label, { message: error instanceof Error ? error.message : String(error) });
};

const getAuditProviderFailureStatus = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\bstatus\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
};

const isDefiniteAuditStepFailure = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Brevo contact ID is unavailable")) return true;
  const status = getAuditProviderFailureStatus(error);
  return status !== null && status >= 400 && status < 500 && status !== 408;
};

const isReplaySafeAuditStepName = (step) =>
  step === "audit-mongo-persistence" || step === "audit-meta-capi";

const getAuditStepStoreOptions = () => ({
  mongoUri: getEnv("MONGODB_URI"),
  databaseName: getEnv("MONGODB_DATABASE") || "alphatrack",
});

const runIdempotentAuditStep = async (dedupeKey, step, action, errorLabel) => {
  const stepKey = `${dedupeKey}/${step}`;
  const storeOptions = getAuditStepStoreOptions();
  let claimed = false;

  try {
    claimed = await claimAuditStep(stepKey, storeOptions);
    if (!claimed) return;
    await action();
    await completeAuditStep(stepKey, storeOptions);
  } catch (error) {
    const shouldReleaseClaim = isReplaySafeAuditStepName(step) || isDefiniteAuditStepFailure(error);
    if (claimed && shouldReleaseClaim) {
      await releaseAuditStep(stepKey, storeOptions).catch((releaseError) => logNonFatal(`${errorLabel} (claim release failed)`, releaseError));
    } else if (claimed) {
      console.warn(`${errorLabel} (ambiguous provider outcome; preserving claim to prevent replay)`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    logNonFatal(errorLabel, error);
  }
};

const persistTrackingAudit = async (dedupeKey, data, audit, request) => {
  const saved = await saveLeadContact({
    ...data,
    submissionKey: dedupeKey,
    company: audit.company,
    websiteUrl: audit.websiteUrl,
    monthlyAdSpend: audit.mode === "legacy" ? audit.legacyMonthlyAdSpend : "",
    legacyMonthlyAdSpend: audit.legacyMonthlyAdSpend,
    monthlyAdSpendBand: audit.monthlyAdSpendBand,
    adPlatforms: audit.adPlatforms,
    industry: audit.industry,
    role: audit.role,
    decisionInfluence: audit.decisionInfluence,
    trackingMaturity: audit.trackingMaturity,
    primaryConversionType: audit.primaryConversionType,
    measurementProblem: audit.measurementProblem,
    urgency: audit.urgency,
  }, getClientIp(request), getEnv("MONGODB_URI"), getEnv("MONGODB_DATABASE") || "alphatrack");
  if (!saved) throw new Error("MongoDB Tracking Audit persistence is not configured.");
};

const completeAuditSideEffects = async (dedupeKey, data, audit, contactId, apiKey, request) => {
  await runIdempotentAuditStep(
    dedupeKey,
    "audit-mongo-persistence",
    () => persistTrackingAudit(dedupeKey, data, audit, request),
    "MongoDB Tracking Audit persistence failed after successful Brevo capture",
  );

  let resolvedContactId = contactId;
  if (!resolvedContactId) {
    resolvedContactId = (await getBrevoContactByEmail(data.email, apiKey))?.id;
  }

  await runIdempotentAuditStep(
    dedupeKey,
    "audit-review-task",
    async () => {
      if (!resolvedContactId) throw new Error("Brevo contact ID is unavailable for Tracking Audit review task.");
      await createAuditReviewTask(data, audit, resolvedContactId, apiKey);
    },
    "Brevo Tracking Audit review task failed after successful capture",
  );
  await runIdempotentAuditStep(
    dedupeKey,
    "audit-internal-alert",
    () => sendInternalNotification(data, audit, apiKey),
    "Tracking Audit internal notification failed after successful capture",
  );
  await runIdempotentAuditStep(
    dedupeKey,
    "audit-applicant-receipt",
    () => sendApplicantReceipt(data, apiKey),
    "Tracking Audit applicant receipt failed after successful capture",
  );
  await runIdempotentAuditStep(
    dedupeKey,
    "audit-meta-capi",
    () => sendMetaConversionEvent(data, request),
    "Meta CAPI Tracking Audit lead event failed after successful capture",
  );
};

export default async (request) => {
  const corsHeaders = getCorsHeaders(request);
  if (hasDisallowedBrowserOrigin(request, getEnv("CONTEXT"), getEnv("ALLOWED_ORIGINS"))) {
    return json({ ok: false, message: "Origin not allowed." }, { status: 403, headers: corsHeaders });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS", "cache-control": "no-store", ...corsHeaders } });
  }
  if (request.method !== "POST") {
    return json({ ok: false, message: "Method not allowed" }, { status: 405, headers: { allow: "POST, OPTIONS", ...corsHeaders } });
  }
  if (isRateLimited(getClientIp(request))) {
    return json({ ok: false, message: "Too many requests. Please try again shortly." }, { status: 429, headers: corsHeaders });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON payload." }, { status: 400, headers: corsHeaders });
  }
  if (!payload || payload.source !== "tracking_audit_offer" || !String(payload.email || "").trim() || !String(payload.firstName || "").trim() || !String(payload.lastName || "").trim()) {
    return json({ ok: false, message: "Invalid submission payload." }, { status: 400, headers: corsHeaders });
  }

  const normalized = normalizeTrackingAuditApplication(payload);
  if (!normalized.ok) {
    return json({ ok: false, message: "Invalid submission payload." }, { status: 400, headers: corsHeaders });
  }
  const audit = normalized.value;
  const apiKey = getEnv("BREVO_API_KEY")?.trim();
  const auditListId = Number(getEnv("BREVO_AUDIT_LIST_ID") || "11");
  if (!apiKey) return json({ ok: false, message: "Lead service is not configured." }, { status: 500, headers: corsHeaders });

  const dedupeKey = buildLeadDedupeKey(payload);
  const existingSubmission = await getIdempotencyRecord(dedupeKey);
  const isDuplicate = Boolean(existingSubmission);
  if (isDuplicate) {
    const storedContactId = existingSubmission?.contactId;
    const contactId = typeof storedContactId === "string" || typeof storedContactId === "number"
      ? storedContactId
      : undefined;
    await completeAuditSideEffects(dedupeKey, payload, audit, contactId, apiKey, request);
    return json({ ok: true, pendingConfirmation: false, duplicate: true, metaEventId: payload.metaEventId }, { headers: corsHeaders });
  }

  try {
    const existingContact = await getBrevoContactByEmail(payload.email, apiKey);
    const upsert = await upsertBrevoContact(payload, audit, existingContact, auditListId, apiKey);
    if (!upsert.ok) {
      console.error("Brevo Tracking Audit capture failed", { listId: auditListId, status: upsert.status });
      return json({ ok: false, message: "Unable to submit lead right now." }, { status: 502, headers: corsHeaders });
    }

    await markIdempotencyKey(dedupeKey, {
      source: payload.source,
      emailHash: dedupeKey.split("/").at(-1),
      listId: auditListId,
      auditMode: audit.mode,
      ...(upsert.contactId ? { contactId: upsert.contactId } : {}),
    });

    await completeAuditSideEffects(dedupeKey, payload, audit, upsert.contactId, apiKey, request);

    return json({ ok: true, pendingConfirmation: false, duplicate: false, metaEventId: payload.metaEventId }, { headers: corsHeaders });
  } catch (error) {
    console.error("Tracking Audit submission failed", { message: error instanceof Error ? error.message : String(error) });
    return json({ ok: false, message: "Unable to submit lead right now." }, { status: 500, headers: corsHeaders });
  }
};