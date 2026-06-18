import { createHash } from "node:crypto";
import { buildExitPopupDedupeKey, getIdempotencyRecord, markIdempotencyKey } from "./_lib/idempotency";

interface SubscribePayload {
  firstName: string;
  email: string;
  website?: string;
  optIn?: boolean;
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
  landingPage?: string;
  referrer?: string;
  fbp?: string;
  fbc?: string;
}

interface Req {
  method?: string;
  body?: SubscribePayload;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

interface Res {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string) => void;
  end: () => void;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const SOURCE = "ATD Website Exit Popup";
const LEAD_SOURCE = "exit_popup";

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

const getHeader = (headers: Req["headers"], name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const setCorsHeaders = (req: Req, res: Res) => {
  const origin = getHeader(req.headers, "origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
};

const getClientIp = (req: Req) => {
  const directIp = getHeader(req.headers, "x-nf-client-connection-ip");
  if (directIp) return directIp;

  const forwarded = getHeader(req.headers, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  return getHeader(req.headers, "client-ip") || req.socket?.remoteAddress || "unknown";
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

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const isValidOptionalWebsite = (value: string) => {
  if (!value) return true;

  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    return url.hostname.includes(".");
  } catch {
    return false;
  }
};

const normalizeWebsite = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
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

const truncateAttribute = (value: unknown, maxLength = 500) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const sha256 = (value: string) =>
  createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

const getAttributionAttributes = (attribution: LeadAttribution | undefined): Record<string, string> => {
  const safeAttribution = attribution && typeof attribution === "object" ? attribution : {};
  return Object.fromEntries(
    [
      ["UTM_SOURCE", truncateAttribute(safeAttribution.utmSource)],
      ["UTM_MEDIUM", truncateAttribute(safeAttribution.utmMedium)],
      ["UTM_CAMPAIGN", truncateAttribute(safeAttribution.utmCampaign)],
      ["UTM_CONTENT", truncateAttribute(safeAttribution.utmContent)],
      ["UTM_TERM", truncateAttribute(safeAttribution.utmTerm)],
      ["GCLID", truncateAttribute(safeAttribution.gclid)],
      ["FBCLID", truncateAttribute(safeAttribution.fbclid)],
      ["LANDING_PAGE", truncateAttribute(safeAttribution.landingPage)],
      ["REFERRER", truncateAttribute(safeAttribution.referrer)],
    ].filter(([, value]) => value.length > 0),
  );
};

type BrevoContact = {
  id?: number;
  attributes?: Record<string, unknown>;
};

const getStringAttribute = (contact: BrevoContact | undefined, name: string) => {
  const value = contact?.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
};

const getBrevoContactByEmail = async (email: string, apiKey: string): Promise<BrevoContact | undefined> => {
  const response = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { "api-key": apiKey },
  });

  if (!response.ok) return undefined;
  return response.json().catch(() => undefined) as Promise<BrevoContact | undefined>;
};

const validatePayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return null;

  const data = payload as Record<string, unknown>;
  const firstName = typeof data.firstName === "string" ? data.firstName.trim() : "";
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const website = typeof data.website === "string" ? data.website.trim() : "";
  const websiteRoute =
    normalizeRoute(typeof data.websiteRoute === "string" ? data.websiteRoute : "") ||
    normalizeRoute(typeof data.route === "string" ? data.route : "") ||
    normalizeRoute(typeof data.pagePath === "string" ? data.pagePath : "");
  const optIn = data.optIn === true;
  const metaEventId = typeof data.metaEventId === "string" ? data.metaEventId.trim().slice(0, 128) : "";
  const attribution = data.attribution && typeof data.attribution === "object"
    ? data.attribution as LeadAttribution
    : undefined;

  if (!firstName || !isValidEmail(email) || !isValidOptionalWebsite(website)) {
    return null;
  }

  return {
    firstName,
    email,
    website: normalizeWebsite(website),
    websiteRoute: websiteRoute || "/",
    optIn,
    attribution,
    metaEventId,
  };
};

const getMetaEventSourceUrl = (lead: ReturnType<typeof validatePayload> extends infer T ? NonNullable<T> : never) => {
  try {
    return new URL(lead.attribution?.landingPage || lead.websiteRoute || "/", "https://alphatrack.digital").toString();
  } catch {
    return `https://alphatrack.digital${lead.websiteRoute || "/"}`;
  }
};

const sendMetaConversionEvent = async (
  lead: ReturnType<typeof validatePayload> extends infer T ? NonNullable<T> : never,
  req: Req,
) => {
  const pixelId = process.env.META_PIXEL_ID?.trim();
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN?.trim();

  if (!pixelId || !accessToken) {
    console.info("Meta CAPI is not configured; skipping exit popup event.");
    return;
  }

  const graphVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v23.0";
  const testEventCode = process.env.META_CAPI_TEST_EVENT_CODE?.trim();
  const eventId = lead.metaEventId || buildExitPopupDedupeKey(lead);
  const clientIp = getClientIp(req);
  const userAgent = getHeader(req.headers, "user-agent") || "";

  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            event_name: "Lead",
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            action_source: "website",
            event_source_url: getMetaEventSourceUrl(lead),
            user_data: {
              em: [sha256(lead.email)],
              fn: [sha256(lead.firstName)],
              ...(lead.attribution?.fbp ? { fbp: lead.attribution.fbp } : {}),
              ...(lead.attribution?.fbc ? { fbc: lead.attribution.fbc } : {}),
              ...(clientIp !== "unknown" ? { client_ip_address: clientIp } : {}),
              ...(userAgent ? { client_user_agent: userAgent } : {}),
            },
            custom_data: {
              lead_source: "exit_popup",
              content_name: "Exit Popup Growth Audit",
              website_route: lead.websiteRoute,
            },
          },
        ],
        ...(testEventCode ? { test_event_code: testEventCode } : {}),
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta CAPI rejected the exit popup event. ${errorText.slice(0, 180)}`);
  }
};

const withConsentAttributes = (
  attributes: Record<string, string | boolean>,
  lead: ReturnType<typeof validatePayload> extends infer T ? NonNullable<T> : never,
  existingContact?: BrevoContact,
) => {
  const timestamp = new Date().toISOString();
  const existingSource = getStringAttribute(existingContact, "SOURCE");
  const existingLeadSource = getStringAttribute(existingContact, "LEAD_SOURCE");
  const previousHistory = getStringAttribute(existingContact, "SOURCE_HISTORY");
  const route = lead.websiteRoute;
  const historyEntry = `${timestamp} | ${SOURCE} | ${LEAD_SOURCE} | ${route}`;
  const nextAttributes: Record<string, string | boolean> = {
    ...attributes,
    SOURCE,
    LEAD_SOURCE,
    FIRST_SOURCE: getStringAttribute(existingContact, "FIRST_SOURCE") || existingSource || SOURCE,
    FIRST_LEAD_SOURCE:
      getStringAttribute(existingContact, "FIRST_LEAD_SOURCE") ||
      existingLeadSource ||
      LEAD_SOURCE,
    FIRST_SOURCE_TIMESTAMP: getStringAttribute(existingContact, "FIRST_SOURCE_TIMESTAMP") || timestamp,
    LAST_SOURCE: SOURCE,
    LAST_LEAD_SOURCE: LEAD_SOURCE,
    LAST_SOURCE_TIMESTAMP: timestamp,
    SOURCE_HISTORY: [previousHistory, historyEntry].filter(Boolean).join("\n").slice(-2000),
    WEBSITE_ROUTE: route,
    OFFER: "exit-popup",
    CONSENT_STATUS: lead.optIn === true ? "opted_in" : "not_provided",
    CONSENT_TIMESTAMP: timestamp,
    ...getAttributionAttributes(lead.attribution),
  };

  if (lead.optIn !== true) return nextAttributes;

  nextAttributes.OPT_IN = true;

  const consentAttribute = process.env.BREVO_CONSENT_ATTRIBUTE?.trim();
  const consentTimestampAttribute = process.env.BREVO_CONSENT_TIMESTAMP_ATTRIBUTE?.trim();

  if (consentAttribute) nextAttributes[consentAttribute] = "Yes";
  if (consentTimestampAttribute) nextAttributes[consentTimestampAttribute] = timestamp;

  return nextAttributes;
};

const handler = async (req: Req, res: Res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ ok: false, message: "Too many requests. Please try again shortly." });
  }

  const lead = validatePayload(req.body);
  if (!lead) {
    return res.status(400).json({ ok: false, message: "Please check your details and try again." });
  }

  const brevoApiKey = process.env.BREVO_API_KEY;
  const brevoListId = Number(process.env.BREVO_LIST_ID || "10");

  if (!brevoApiKey || !Number.isInteger(brevoListId) || brevoListId <= 0) {
    return res.status(500).json({ ok: false, message: "Lead service is not configured." });
  }

  const dedupeKey = buildExitPopupDedupeKey(lead);
  const existingSubmission = await getIdempotencyRecord(dedupeKey);
  const isDuplicate = Boolean(existingSubmission);

  try {
    const existingBrevoContact = await getBrevoContactByEmail(lead.email, brevoApiKey);
    const brevoResponse = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": brevoApiKey,
      },
      body: JSON.stringify({
        email: lead.email,
        attributes: withConsentAttributes({
          FIRSTNAME: lead.firstName,
          WEBSITE: lead.website,
        }, lead, existingBrevoContact),
        listIds: [brevoListId],
        updateEnabled: true,
      }),
    });

    if (!brevoResponse.ok) {
      const errorText = await brevoResponse.text().catch(() => "");
      console.error("Brevo exit popup contact upsert failed", {
        status: brevoResponse.status,
        listId: brevoListId,
        message: errorText.slice(0, 300),
      });

      return res.status(502).json({ ok: false, message: "Unable to submit lead right now." });
    }

    if (!isDuplicate) {
      await markIdempotencyKey(dedupeKey, {
        source: "exit_popup",
        emailHash: dedupeKey.split("/").at(-1),
        listId: brevoListId,
      });

      await sendMetaConversionEvent(lead, req).catch((error) => {
        console.error("Meta CAPI exit popup event failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return res.status(200).json({ ok: true, duplicate: isDuplicate, metaEventId: lead.metaEventId });
  } catch (error) {
    console.error("Brevo exit popup submission failed", {
      listId: brevoListId,
      message: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({ ok: false, message: "Unable to submit lead right now." });
  }
};

export default handler;
