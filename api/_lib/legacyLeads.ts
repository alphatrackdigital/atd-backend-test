import { buildLeadDedupeKey, getIdempotencyRecord, markIdempotencyKey } from "./_lib/idempotency";
import { createHash } from "node:crypto";
import { connectDB } from "./_lib/db";
import { Contact } from "./_lib/models/Contact";

type LeadSource = "contact_form" | "tracking_audit_offer" | "newsletter";

interface LeadPayload {
  source: LeadSource;
  firstName: string;
  lastName: string;
  email: string;
  optIn?: boolean;
  company?: string;
  message?: string;
  websiteUrl?: string;
  monthlyAdSpend?: string;
  adPlatforms?: string;
  serviceInterest?: string[];
  monthlyBudget?: string;
  websiteRoute?: string;
  route?: string;
  pagePath?: string;
  attribution?: LeadAttribution;
  metaEventId?: string;
}

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

interface Req {
  method?: string;
  body?: LeadPayload;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

interface Res {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

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
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
};

const isValidLeadPayload = (payload: unknown): payload is LeadPayload => {
  if (!payload || typeof payload !== "object") return false;
  const data = payload as Record<string, unknown>;
  if (data.source !== "contact_form" && data.source !== "tracking_audit_offer" && data.source !== "newsletter") return false;
  if (typeof data.email !== "string" || !data.email.trim()) return false;
  if (data.source !== "newsletter") {
    if (typeof data.firstName !== "string" || !data.firstName.trim()) return false;
    if (typeof data.lastName !== "string" || !data.lastName.trim()) return false;
  }
  if (data.source === "contact_form") {
    if (!Array.isArray(data.serviceInterest) || data.serviceInterest.length === 0) return false;
  }
  if (data.source === "newsletter") {
    if (data.optIn !== true) return false;
  }
  if (data.source === "tracking_audit_offer") {
    if (typeof data.websiteUrl !== "string" || !data.websiteUrl.trim()) return false;
    if (typeof data.monthlyAdSpend !== "string" || !data.monthlyAdSpend.trim()) return false;
    if (typeof data.adPlatforms !== "string" || !data.adPlatforms.trim()) return false;
  }
  return true;
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

const saveToMongoDB = async (payload: LeadPayload, ip: string) => {
  if (!process.env.MONGODB_URI || payload.source === "newsletter") return;

  try {
    await connectDB();
    await Contact.create({
      source: payload.source,
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      company: payload.company || "",
      message: payload.message || "",
      websiteUrl: payload.websiteUrl || "",
      monthlyAdSpend: payload.monthlyAdSpend || "",
      adPlatforms: payload.adPlatforms || "",
      serviceInterest: Array.isArray(payload.serviceInterest) ? payload.serviceInterest.join(", ") : "",
      monthlyBudget: payload.monthlyBudget || "",
      ip,
    });
  } catch (error) {
    console.error("[leads] MongoDB save error (non-fatal):", {
      source: payload.source,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const buildMessageAttribute = (data: LeadPayload) => {
  return data.message?.trim() || "";
};

const getHeader = (headers: Req["headers"], name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const truncateAttribute = (value: unknown, maxLength = 500) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const getAttributionAttributes = (data: LeadPayload): Record<string, string> => {
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

const getDealReportingAttributes = (data: LeadPayload): Record<string, string> => {
  const meta = campaignMetadata[data.source];
  return Object.fromEntries(
    [
      ["atd_lead_source", meta.leadSource],
      ["atd_offer", meta.offer],
      ["atd_website_route", getSubmittedRoute(data)],
      ["atd_utm_source", truncateAttribute(data.attribution?.utmSource)],
      ["atd_utm_campaign", truncateAttribute(data.attribution?.utmCampaign)],
    ].filter(([, value]) => value.length > 0),
  );
};

const sourceLabels: Record<LeadSource, string> = {
  contact_form: "Contact Form",
  newsletter: "Newsletter",
  tracking_audit_offer: "Tracking Audit Landing Page",
};

const campaignMetadata: Record<LeadSource, { leadSource: string; websiteRoute: string; offer: string }> = {
  contact_form: { leadSource: "contact_form", websiteRoute: "/contact-us", offer: "general-enquiry" },
  newsletter: { leadSource: "newsletter", websiteRoute: "/newsletter", offer: "newsletter-signup" },
  tracking_audit_offer: { leadSource: "tracking_audit_offer", websiteRoute: "/offer/tracking-audit", offer: "tracking-audit" },
};

const crmConfig = {
  ownerId: "68bf7b64faf0e9c68b0ccdb4",
  pipelineId: "68bf7ba1f6e11688cf7a2164",
  taskTypeId: "68bf7ba1f6e11688cf7a215e",
  stages: {
    new: "8dae99f7-6de0-4c1f-9ca6-b5ee72a40d85",
    qualifying: "089c5fc7-da86-489a-a3b5-503bc5d4bd54",
  },
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

const getLeadDisplayName = (data: LeadPayload) => `${data.firstName || ""} ${data.lastName || ""}`.trim() || data.email;

const leadNotificationConfig: Partial<Record<LeadSource, {
  senderEmail: string;
  recipients: string[];
  subject: string;
  label: string;
}>> = {
  contact_form: {
    senderEmail: "info@alphatrack.digital",
    recipients: ["info@alphatrack.digital"],
    subject: "New website contact form enquiry",
    label: "Website contact form enquiry",
  },
  tracking_audit_offer: {
    senderEmail: "audit@alphatrack.digital",
    recipients: ["audit@alphatrack.digital", "martech@alphatrack.digital"],
    subject: "New tracking audit request",
    label: "Tracking audit request",
  },
  newsletter: {
    senderEmail: "marketing@alphatrack.digital",
    recipients: ["marketing@alphatrack.digital"],
    subject: "New newsletter signup",
    label: "Newsletter signup",
  },
};

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const buildNotificationRows = (data: LeadPayload) => [
  ["Source", sourceLabels[data.source]],
  ["Name", `${data.firstName} ${data.lastName}`.trim()],
  ["Email", data.email],
  ["Company", data.company || ""],
  ["Website", data.websiteUrl || ""],
  ["Service Interest", Array.isArray(data.serviceInterest) ? data.serviceInterest.join(", ") : ""],
  ["Monthly Budget", data.monthlyBudget || ""],
  ["Monthly Ad Spend", data.monthlyAdSpend || ""],
  ["Ad Platforms", data.adPlatforms || ""],
  ["UTM Source", data.attribution?.utmSource || ""],
  ["UTM Medium", data.attribution?.utmMedium || ""],
  ["UTM Campaign", data.attribution?.utmCampaign || ""],
  ["Landing Page", data.attribution?.landingPage || ""],
  ["Referrer", data.attribution?.referrer || ""],
  ["Marketing Opt-in", data.optIn === true ? "Yes" : "No"],
  ["Message", buildMessageAttribute(data)],
].filter(([, value]) => String(value).trim().length > 0);

const buildNotificationEmail = (
  data: LeadPayload,
  config: NonNullable<typeof leadNotificationConfig[LeadSource]>,
) => {
  const rows = buildNotificationRows(data);
  const textContent = [
    config.label,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");

  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 700;">${escapeHtml(label)}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(value).replace(/\n/g, "<br />")}</td>
        </tr>`,
    )
    .join("");

  const htmlContent = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; line-height: 1.5;">
      <h1 style="font-size: 20px; margin: 0 0 16px;">${escapeHtml(config.label)}</h1>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 720px; border: 1px solid #e5e7eb;">
        ${htmlRows}
      </table>
    </div>`;

  return { textContent, htmlContent };
};

const getCrmHandoff = (data: LeadPayload) => {
  if (data.source === "contact_form") {
    return {
      dealStage: crmConfig.stages.qualifying,
      dealName: `${data.company || getLeadDisplayName(data)} - General enquiry`,
      taskName: `Reply to contact enquiry - ${data.company || getLeadDisplayName(data)}`,
      taskNotes: "Website contact form enquiry. Review service interest and reply within 1 business day.",
    };
  }

  if (data.source === "tracking_audit_offer") {
    return {
      dealStage: crmConfig.stages.new,
      dealName: `${data.websiteUrl || data.company || getLeadDisplayName(data)} - Tracking audit`,
      taskName: `Review tracking audit request - ${data.websiteUrl || getLeadDisplayName(data)}`,
      taskNotes: "Tracking audit request. Review website, ad platforms, and monthly ad spend within 1 business day.",
    };
  }

  return null;
};

const createCrmDealAndTask = async (data: LeadPayload, contactId: number | string | undefined, apiKey: string) => {
  const handoff = getCrmHandoff(data);
  if (!handoff || !contactId) return;

  const descriptionRows = buildNotificationRows(data)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  const dealResponse = await fetch("https://api.brevo.com/v3/crm/deals", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      name: handoff.dealName,
      attributes: {
        deal_owner: crmConfig.ownerId,
        pipeline: crmConfig.pipelineId,
        deal_stage: handoff.dealStage,
        deal_description: descriptionRows,
        ...getDealReportingAttributes(data),
      },
      linkedContactsIds: [Number(contactId)],
    }),
  });

  if (!dealResponse.ok) {
    const errorText = await dealResponse.text();
    throw new Error(`Brevo CRM deal creation failed. ${errorText.slice(0, 180)}`);
  }

  const deal = await dealResponse.json().catch(() => ({})) as { id?: number | string };
  const taskResponse = await fetch("https://api.brevo.com/v3/crm/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      name: handoff.taskName,
      date: getNextBusinessDayIso(),
      taskTypeId: crmConfig.taskTypeId,
      assignToId: crmConfig.ownerId,
      contactsIds: [Number(contactId)],
      dealsIds: deal.id ? [deal.id] : [],
      notes: handoff.taskNotes,
      done: false,
    }),
  });

  if (!taskResponse.ok) {
    const errorText = await taskResponse.text();
    throw new Error(`Brevo CRM task creation failed. ${errorText.slice(0, 180)}`);
  }
};

const sendInternalNotification = async (data: LeadPayload, brevoApiKey: string) => {
  const config = leadNotificationConfig[data.source];
  if (!config) return;

  const { textContent, htmlContent } = buildNotificationEmail(data, config);

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": brevoApiKey,
    },
    body: JSON.stringify({
      sender: { name: "AlphaTrack Digital", email: config.senderEmail },
      to: config.recipients.map((email) => ({ email })),
      replyTo: { email: config.senderEmail, name: "AlphaTrack Digital" },
      subject: config.subject,
      htmlContent,
      textContent,
      tags: [data.source],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send internal notification. ${errorText.slice(0, 180)}`);
  }
};

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

const getSubmittedRoute = (data: LeadPayload) =>
  normalizeRoute(data.websiteRoute) ||
  normalizeRoute(data.route) ||
  normalizeRoute(data.pagePath) ||
  campaignMetadata[data.source].websiteRoute ||
  "/";

const sha256 = (value: string) =>
  createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

const getMetaEventName = (source: LeadSource) => {
  if (source === "newsletter") return "Subscribe";
  return "Lead";
};

const getMetaEventSourceUrl = (data: LeadPayload) => {
  const route = getSubmittedRoute(data);
  try {
    return new URL(data.attribution?.landingPage || route, "https://alphatrack.digital").toString();
  } catch {
    return `https://alphatrack.digital${route}`;
  }
};

const sendMetaConversionEvent = async (data: LeadPayload, req: Req) => {
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

  const body = {
    data: [
      {
        event_name: getMetaEventName(data.source),
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url: getMetaEventSourceUrl(data),
        user_data: {
          em: [sha256(data.email)],
          ...(data.firstName ? { fn: [sha256(data.firstName)] } : {}),
          ...(data.lastName ? { ln: [sha256(data.lastName)] } : {}),
          ...(data.attribution?.fbp ? { fbp: data.attribution.fbp } : {}),
          ...(data.attribution?.fbc ? { fbc: data.attribution.fbc } : {}),
          ...(getClientIp(req) !== "unknown" ? { client_ip_address: getClientIp(req) } : {}),
          ...(userAgent ? { client_user_agent: userAgent } : {}),
        },
        custom_data: {
          lead_source: data.source,
          content_name: sourceLabels[data.source],
          website_route: getSubmittedRoute(data),
          ...(data.attribution?.utmSource ? { utm_source: data.attribution.utmSource } : {}),
          ...(data.attribution?.utmCampaign ? { utm_campaign: data.attribution.utmCampaign } : {}),
          ...(data.attribution?.fbclid ? { fbclid: data.attribution.fbclid } : {}),
        },
      },
    ],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };

  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta CAPI rejected the lead event. ${errorText.slice(0, 180)}`);
  }
};

type BrevoAttributeValue = string | boolean | string[];
type BrevoContact = {
  id?: number;
  attributes?: Record<string, unknown>;
};

const toServiceInterestAttribute = (serviceInterest?: string[]) =>
  Array.isArray(serviceInterest)
    ? serviceInterest.map((item) => item.trim()).filter(Boolean)
    : [];

const monthlyBudgetValues: Record<string, string> = {
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "<$500": "1",
  "Under $500": "1",
  "$500-$1,500": "2",
  "$500–$1,500": "2",
  "$1,500-$5,000": "3",
  "$1,500–$5,000": "3",
  "$5,000+": "4",
};

const toMonthlyBudgetAttribute = (monthlyBudget?: string) => {
  const value = monthlyBudget?.trim();
  return value ? monthlyBudgetValues[value] ?? value : "";
};

const withCampaignAndConsentAttributes = (
  attributes: Record<string, BrevoAttributeValue>,
  data: LeadPayload,
  existingContact?: BrevoContact,
) => {
  const meta = campaignMetadata[data.source];
  const timestamp = new Date().toISOString();
  const nextAttributes: Record<string, BrevoAttributeValue> = {
    ...attributes,
    LEAD_SOURCE: meta.leadSource,
    ...getSourceLifecycleAttributes(data, existingContact, timestamp),
    WEBSITE_ROUTE: getSubmittedRoute(data),
    OFFER: meta.offer,
    CONSENT_STATUS: data.optIn === true ? "opted_in" : "not_provided",
    CONSENT_TIMESTAMP: timestamp,
    ...getAttributionAttributes(data),
  };

  if (data.optIn !== true) {
    return nextAttributes;
  }

  nextAttributes.OPT_IN = true;

  const consentAttribute = process.env.BREVO_CONSENT_ATTRIBUTE?.trim();
  const consentTimestampAttribute = process.env.BREVO_CONSENT_TIMESTAMP_ATTRIBUTE?.trim();

  if (consentAttribute) {
    nextAttributes[consentAttribute] = "Yes";
  }

  if (consentTimestampAttribute) {
    nextAttributes[consentTimestampAttribute] = timestamp;
  }

  return nextAttributes;
};

const getStringAttribute = (contact: BrevoContact | undefined, name: string) => {
  const value = contact?.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
};

const getSourceLifecycleAttributes = (
  data: LeadPayload,
  existingContact: BrevoContact | undefined,
  timestamp: string,
): Record<string, string> => {
  const meta = campaignMetadata[data.source];
  const currentSource = sourceLabels[data.source];
  const currentLeadSource = meta.leadSource;
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
      getStringAttribute(existingContact, "FIRST_LEAD_SOURCE") ||
      existingLeadSource ||
      currentLeadSource,
    FIRST_SOURCE_TIMESTAMP: getStringAttribute(existingContact, "FIRST_SOURCE_TIMESTAMP") || timestamp,
    SOURCE_HISTORY: sourceHistory,
  };
};

const toBrevoPayload = (data: LeadPayload, listId: number, existingContact?: BrevoContact) => ({
  email: data.email,
  attributes: withCampaignAndConsentAttributes({
    FIRSTNAME: data.firstName,
    LASTNAME: data.lastName,
    COMPANY: data.company || "",
    MESSAGE: buildMessageAttribute(data),
    WEBSITE: data.websiteUrl || "",
    AD_SPEND: data.monthlyAdSpend || "",
    AD_PLATFORMS: data.adPlatforms || "",
    SERVICE_INTEREST: toServiceInterestAttribute(data.serviceInterest),
    MONTHLY_BUDGET: toMonthlyBudgetAttribute(data.monthlyBudget),
  }, data, existingContact),
  listIds: [listId],
  updateEnabled: true,
});

const toBrevoDoiPayload = (
  data: LeadPayload,
  listId: number,
  templateId: number,
  redirectUrl: string,
  existingContact?: BrevoContact,
) => ({
  email: data.email,
  includeListIds: [listId],
  templateId,
  redirectionUrl: redirectUrl,
  attributes: withCampaignAndConsentAttributes({
  }, data, existingContact),
});

const getBrevoContactByEmail = async (email: string, brevoApiKey: string): Promise<BrevoContact | undefined> => {
  const response = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { "api-key": brevoApiKey },
  });

  if (!response.ok) return undefined;

  const contact = await response.json().catch(() => ({}));
  return contact as BrevoContact;
};

const ensureContactInList = async (email: string, listId: number, brevoApiKey: string) => {
  const response = await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts/add`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": brevoApiKey,
    },
    body: JSON.stringify({ emails: [email] }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn("Brevo list add failed after contact upsert", {
      listId,
      message: errorText.slice(0, 180),
    });
  }
};

const handler = async (req: Req, res: Res) => {
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
  if (!isValidLeadPayload(payload)) {
    return res.status(400).json({ ok: false, message: "Invalid submission payload." });
  }
  await saveToMongoDB(payload, ip);

  const brevoApiKey = process.env.BREVO_API_KEY;
  const contactListId = Number(process.env.BREVO_CONTACT_LIST_ID || "8");
  const auditListId = Number(process.env.BREVO_AUDIT_LIST_ID || "11");
  const newsletterListId = Number(process.env.BREVO_NEWSLETTER_LIST_ID || "9");
  const newsletterDoiTemplateId = Number(process.env.BREVO_DOI_TEMPLATE_ID || "0");
  const newsletterDoiRedirectUrl = process.env.BREVO_DOI_REDIRECT_URL?.trim() || "";

  if (!brevoApiKey) {
    return res.status(500).json({ ok: false, message: "Lead service is not configured." });
  }

  const listId =
    payload.source === "contact_form"
      ? contactListId
      : payload.source === "newsletter"
        ? newsletterListId
        : auditListId;
  const dedupeKey = buildLeadDedupeKey(payload as unknown as Record<string, unknown>);
  const existingSubmission = await getIdempotencyRecord(dedupeKey);
  const isDuplicate = Boolean(existingSubmission);

  try {
    const isNewsletterDoiEnabled =
      payload.source === "newsletter" &&
      Number.isInteger(newsletterDoiTemplateId) &&
      newsletterDoiTemplateId > 0 &&
      newsletterDoiRedirectUrl.length > 0;

    if (isDuplicate && isNewsletterDoiEnabled) {
      return res.status(200).json({ ok: true, pendingConfirmation: true, duplicate: true });
    }

    const existingBrevoContact = await getBrevoContactByEmail(payload.email, brevoApiKey);
    let pendingConfirmation = isNewsletterDoiEnabled;
    let brevoResponse = await fetch(
      isNewsletterDoiEnabled
        ? "https://api.brevo.com/v3/contacts/doubleOptinConfirmation"
        : "https://api.brevo.com/v3/contacts",
      {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": brevoApiKey,
      },
        body: JSON.stringify(
          isNewsletterDoiEnabled
            ? toBrevoDoiPayload(payload, listId, newsletterDoiTemplateId, newsletterDoiRedirectUrl, existingBrevoContact)
            : toBrevoPayload(payload, listId, existingBrevoContact),
        ),
      },
    );

    if (!brevoResponse.ok && isNewsletterDoiEnabled) {
      const errorText = await brevoResponse.text();
      if (errorText.includes("active DOI template") || errorText.includes("invalid_parameter")) {
        pendingConfirmation = false;
        brevoResponse = await fetch("https://api.brevo.com/v3/contacts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": brevoApiKey,
          },
          body: JSON.stringify(toBrevoPayload(payload, listId, existingBrevoContact)),
        });
      } else {
        return res.status(502).json({
          ok: false,
          message: `Failed to submit lead to provider. ${errorText.slice(0, 180)}`,
        });
      }
    }

    if (!brevoResponse.ok) {
      const errorText = await brevoResponse.text();
      return res.status(502).json({
        ok: false,
        message: `Failed to submit lead to provider. ${errorText.slice(0, 180)}`,
      });
    }

    const brevoContact = await brevoResponse.clone().json().catch(() => ({})) as { id?: number | string };
    const brevoContactId = brevoContact.id || existingBrevoContact?.id || (await getBrevoContactByEmail(payload.email, brevoApiKey))?.id;

    if (!pendingConfirmation) {
      await ensureContactInList(payload.email, listId, brevoApiKey);
    }

    if (!isDuplicate) {
      await markIdempotencyKey(dedupeKey, {
        source: payload.source,
        emailHash: dedupeKey.split("/").at(-1),
        listId,
      });
      await createCrmDealAndTask(payload, brevoContactId, brevoApiKey).catch((error) => {
        console.error("Brevo CRM handoff failed after successful capture", {
          source: payload.source,
          listId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      await sendInternalNotification(payload, brevoApiKey).catch((error) => {
        console.error("Lead notification email failed after successful capture", {
          source: payload.source,
          listId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      await sendMetaConversionEvent(payload, req).catch((error) => {
        console.error("Meta CAPI lead tracking failed after successful capture", {
          source: payload.source,
          listId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return res.status(200).json({ ok: true, pendingConfirmation, duplicate: isDuplicate, metaEventId: payload.metaEventId });
  } catch (error) {
    console.error("Lead submission failed", {
      source: payload.source,
      listId,
      message: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({ ok: false, message: "Unable to submit lead right now." });
  }
};

export default handler;
