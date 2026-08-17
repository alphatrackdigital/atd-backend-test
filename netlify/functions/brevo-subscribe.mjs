import { createHash } from "node:crypto";
import { buildExitPopupDedupeKey, getIdempotencyRecord, markIdempotencyKey } from "./lib/idempotency.mjs";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const SOURCE = "ATD Website Exit Popup";
const LEAD_SOURCE = "exit_popup";

const requestBuckets = globalThis.__atdExitPopupRequestBuckets ?? new Map();
globalThis.__atdExitPopupRequestBuckets = requestBuckets;

const json = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });

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

const isAllowedOrigin = (origin) => {
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

const getCorsHeaders = (request) => {
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  };

  if (isAllowedOrigin(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }

  return headers;
};

const getEnv = (name) => {
  if (globalThis.Netlify?.env?.get) {
    return globalThis.Netlify.env.get(name);
  }

  if (typeof process !== "undefined") {
    return process.env[name];
  }

  return undefined;
};

const getClientIp = (request) => {
  const directIp = request.headers.get("x-nf-client-connection-ip");
  if (directIp) return directIp;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  return request.headers.get("client-ip") || "unknown";
};

const isRateLimited = (key) => {
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

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const isValidOptionalWebsite = (value) => {
  if (!value) return true;

  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    return Boolean(url.hostname.includes("."));
  } catch {
    return false;
  }
};

const normalizeWebsite = (value) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
};

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

const truncateAttribute = (value, maxLength = 500) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const sha256 = (value) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

const getAttributionAttributes = (attribution) => {
  const safeAttribution = attribution && typeof attribution === "object" ? attribution : {};
  return Object.fromEntries([
    ["UTM_SOURCE", truncateAttribute(safeAttribution.utmSource)],
    ["UTM_MEDIUM", truncateAttribute(safeAttribution.utmMedium)],
    ["UTM_CAMPAIGN", truncateAttribute(safeAttribution.utmCampaign)],
    ["UTM_CONTENT", truncateAttribute(safeAttribution.utmContent)],
    ["UTM_TERM", truncateAttribute(safeAttribution.utmTerm)],
    ["GCLID", truncateAttribute(safeAttribution.gclid)],
    ["FBCLID", truncateAttribute(safeAttribution.fbclid)],
    ["LANDING_PAGE", truncateAttribute(safeAttribution.landingPage)],
    ["REFERRER", truncateAttribute(safeAttribution.referrer)],
  ].filter(([, value]) => value.length > 0));
};

const getStringAttribute = (contact, name) => {
  const value = contact?.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
};

const getBrevoContactByEmail = async (email, apiKey) => {
  const response = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { "api-key": apiKey },
  });

  if (!response.ok) return undefined;
  return response.json().catch(() => undefined);
};

const validatePayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const firstName = typeof payload.firstName === "string" ? payload.firstName.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const website = typeof payload.website === "string" ? payload.website.trim() : "";
  const route =
    normalizeRoute(payload.websiteRoute) ||
    normalizeRoute(payload.route) ||
    normalizeRoute(payload.pagePath) ||
    "/";
  const attribution = payload.attribution && typeof payload.attribution === "object" ? payload.attribution : undefined;
  const optIn = payload.optIn === true;
  const metaEventId = typeof payload.metaEventId === "string" ? payload.metaEventId.trim().slice(0, 128) : "";

  if (!firstName || !isValidEmail(email) || !isValidOptionalWebsite(website)) {
    return null;
  }

  return {
    firstName,
    email,
    website: normalizeWebsite(website),
    route,
    attribution,
    optIn,
    metaEventId,
  };
};

const getSubmittedRoute = (lead) => {
  if (!lead.route) return "/";
  try {
    const url = new URL(lead.route);
    return url.pathname || "/";
  } catch {
    return lead.route.startsWith("/") ? lead.route : `/${lead.route}`;
  }
};

const addCampaignAttributes = (attributes, lead, existingContact) => {
  const timestamp = new Date().toISOString();
  const route = getSubmittedRoute(lead);
  const existingSource = getStringAttribute(existingContact, "SOURCE");
  const existingLeadSource = getStringAttribute(existingContact, "LEAD_SOURCE");
  const previousHistory = getStringAttribute(existingContact, "SOURCE_HISTORY");
  const historyEntry = `${timestamp} | ${SOURCE} | ${LEAD_SOURCE} | ${route}`;

  return {
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
};

const withConsentAttributes = (attributes, lead, existingContact) => {
  const nextAttributes = addCampaignAttributes(attributes, lead, existingContact);

  if (lead.optIn !== true) {
    return nextAttributes;
  }

  nextAttributes.OPT_IN = true;

  const consentAttribute = getEnv("BREVO_CONSENT_ATTRIBUTE")?.trim();
  const consentTimestampAttribute = getEnv("BREVO_CONSENT_TIMESTAMP_ATTRIBUTE")?.trim();

  if (consentAttribute) {
    nextAttributes[consentAttribute] = "Yes";
  }

  if (consentTimestampAttribute) {
    nextAttributes[consentTimestampAttribute] = nextAttributes.CONSENT_TIMESTAMP;
  }

  return nextAttributes;
};

const getMetaEventSourceUrl = (lead) => {
  try {
    return new URL(lead.attribution?.landingPage || getSubmittedRoute(lead), "https://alphatrack.digital").toString();
  } catch {
    return `https://alphatrack.digital${getSubmittedRoute(lead)}`;
  }
};

const sendMetaConversionEvent = async (lead, request) => {
  const pixelId = getEnv("META_PIXEL_ID")?.trim();
  const accessToken = getEnv("META_CAPI_ACCESS_TOKEN")?.trim();

  if (!pixelId || !accessToken) {
    console.info("Meta CAPI is not configured; skipping exit popup event.");
    return;
  }

  const graphVersion = getEnv("META_GRAPH_API_VERSION")?.trim() || "v23.0";
  const testEventCode = getEnv("META_CAPI_TEST_EVENT_CODE")?.trim();
  const eventId = lead.metaEventId || buildExitPopupDedupeKey(lead);
  const clientIp = getClientIp(request);
  const userAgent = request.headers.get("user-agent") || "";

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
              website_route: getSubmittedRoute(lead),
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

export default async (request) => {
  const corsHeaders = getCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        allow: "POST, OPTIONS",
        "cache-control": "no-store",
        ...corsHeaders,
      },
    });
  }

  if (request.method !== "POST") {
    return json(
      { ok: false, message: "Method not allowed" },
      {
        status: 405,
        headers: { allow: "POST, OPTIONS", ...corsHeaders },
      },
    );
  }

  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return json(
      { ok: false, message: "Too many requests. Please try again shortly." },
      { status: 429, headers: corsHeaders },
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON payload." }, { status: 400, headers: corsHeaders });
  }

  const lead = validatePayload(payload);
  if (!lead) {
    return json({ ok: false, message: "Please check your details and try again." }, { status: 400, headers: corsHeaders });
  }

  const brevoApiKey = getEnv("BREVO_API_KEY");
  const brevoListId = Number(getEnv("BREVO_LIST_ID") || "10");

  if (!brevoApiKey || !Number.isInteger(brevoListId) || brevoListId <= 0) {
    return json({ ok: false, message: "Lead service is not configured." }, { status: 500, headers: corsHeaders });
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

      return json(
        { ok: false, message: "Unable to submit lead right now." },
        { status: 502, headers: corsHeaders },
      );
    }

    if (!isDuplicate) {
      await markIdempotencyKey(dedupeKey, {
        source: "exit_popup",
        emailHash: dedupeKey.split("/").at(-1),
        listId: brevoListId,
      });

      await sendMetaConversionEvent(lead, request).catch((error) => {
        console.error("Meta CAPI exit popup event failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return json({ ok: true, duplicate: isDuplicate, metaEventId: lead.metaEventId }, { headers: corsHeaders });
  } catch (error) {
    console.error("Brevo exit popup submission failed", {
      listId: brevoListId,
      message: error instanceof Error ? error.message : String(error),
    });

    return json({ ok: false, message: "Unable to submit lead right now." }, { status: 500, headers: corsHeaders });
  }
};

export const config = {
  path: "/api/brevo-subscribe",
};
