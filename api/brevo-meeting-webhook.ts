import { buildBookingDedupeKey, getIdempotencyRecord, markIdempotencyKey } from "./_lib/idempotency";
import { createHash } from "node:crypto";

interface Req {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

interface Res {
  status: (code: number) => Res;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string) => void;
  end: () => void;
}

const GA4_COLLECT_ENDPOINT = "https://www.google-analytics.com/mp/collect";
const DEFAULT_EVENT_NAME = ["meeting", "booked", "confirmed"].join("_");

const crmConfig = {
  ownerId: "68bf7b64faf0e9c68b0ccdb4",
  pipelineId: "68bf7ba1f6e11688cf7a2164",
  demoScheduledStageId: "bc2f86a0-8374-479f-bd43-27675c04e31a",
  taskTypeId: "68bf7ba1f6e11688cf7a215e",
};

const getHeader = (headers: Req["headers"], name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const getQueryValue = (req: Req, name: string) => {
  const value = req.query?.[name];
  return Array.isArray(value) ? value[0] : value;
};

const getEnv = (name: string) => process.env[name]?.trim();

const safeString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
type BrevoContact = {
  id?: number;
  attributes?: Record<string, unknown>;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

const findFirstString = (value: unknown, keys: string[]): string => {
  if (!value || typeof value !== "object") return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstString(item, keys);
      if (found) return found;
    }

    return "";
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = safeString(record[key]);
    if (direct) return direct;
  }

  for (const nested of Object.values(record)) {
    const found = findFirstString(nested, keys);
    if (found) return found;
  }

  return "";
};

const toNumericHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0).toString();
};

const getClientId = (payload: unknown) => {
  const explicitClientId = findFirstString(payload, ["client_id", "clientId", "ga_client_id", "gaClientId"]);
  if (explicitClientId) return explicitClientId;

  const gaCookie = findFirstString(payload, ["_ga", "ga_cookie", "gaCookie"]);
  const cookieMatch = gaCookie.match(/GA\d+\.\d+\.(\d+\.\d+)$/);
  if (cookieMatch?.[1]) return cookieMatch[1];

  const stableBookingValue = findFirstString(payload, [
    "meeting_id",
    "meetingId",
    "booking_id",
    "bookingId",
    "meeting_start_timestamp",
  ]);
  const hash = toNumericHash(stableBookingValue || `${Date.now()}`);
  return `${hash.slice(0, 10) || "1"}.${hash.slice(10, 20) || "1"}`;
};

const getSessionId = (payload: unknown) => {
  const explicitSessionId = findFirstString(payload, ["session_id", "sessionId", "ga_session_id", "gaSessionId"]);
  if (/^\d+$/.test(explicitSessionId)) return explicitSessionId;

  const meetingStart = findFirstString(payload, ["meeting_start_timestamp", "meetingStartTimestamp", "startTime"]);
  const startTimestamp = Date.parse(meetingStart);
  if (Number.isFinite(startTimestamp)) {
    return Math.floor(startTimestamp / 1000).toString();
  }

  return Math.floor(Date.now() / 1000).toString();
};

const getMeetingParams = (payload: unknown) => {
  const meetingName = findFirstString(payload, ["meeting_name", "meetingName", "name"]);
  const meetingStart = findFirstString(payload, ["meeting_start_timestamp", "meetingStartTimestamp", "startTime"]);
  const meetingEnd = findFirstString(payload, ["meeting_end_timestamp", "meetingEndTimestamp", "endTime"]);
  const meetingLocation = findFirstString(payload, ["meeting_location", "meetingLocation", "location"]);
  const meetingId = findFirstString(payload, ["meeting_id", "meetingId", "booking_id", "bookingId", "id"]);
  const participantEmail = findFirstString(payload, ["EMAIL", "email"]);
  const pageLocation =
    findFirstString(payload, ["page_location", "pageLocation"]) ||
    getEnv("GA4_BOOKING_PAGE_LOCATION") ||
    "https://alphatrack.digital/book-a-call";

  return {
    booking_id: meetingId || toNumericHash(`${meetingName}:${meetingStart}`),
    booking_email_present: Boolean(participantEmail),
    meeting_name: meetingName || "Brevo meeting",
    meeting_start_timestamp: meetingStart,
    meeting_end_timestamp: meetingEnd,
    meeting_location: meetingLocation,
    source: "brevo_meetings_webhook",
    page_location: pageLocation,
    page_title: "Book A Free Strategy Call | AlphaTrack Digital",
    session_id: getSessionId(payload),
    engagement_time_msec: 1,
  };
};

const getCallPrepDueDateIso = (meetingParams: ReturnType<typeof getMeetingParams>) => {
  const meetingStart = Date.parse(meetingParams.meeting_start_timestamp);
  const dueDate = Number.isFinite(meetingStart) ? new Date(meetingStart) : new Date();
  dueDate.setUTCHours(Math.max(8, dueDate.getUTCHours() - 1), 0, 0, 0);
  return dueDate.toISOString();
};

const getBookingDealReportingAttributes = (meetingParams: ReturnType<typeof getMeetingParams>) => ({
  atd_lead_source: "brevo_meetings_webhook",
  atd_offer: "strategy-call",
  atd_website_route: "/book-a-call",
  atd_utm_source: "",
  atd_utm_campaign: "",
});

const shouldIgnorePayload = (payload: unknown) => {
  const eventText = [
    findFirstString(payload, ["event", "event_name", "eventName", "type", "status", "action"]),
    findFirstString(payload, ["meeting_status", "meetingStatus"]),
  ]
    .join(" ")
    .toLowerCase();

  return /\bcancel|cancelled|canceled|deleted\b/.test(eventText);
};

const authenticate = (req: Req) => {
  const secret = getEnv("BREVO_MEETING_WEBHOOK_SECRET");
  if (!secret) return false;

  const providedSecret =
    getHeader(req.headers, "x-atd-webhook-secret") ||
    getHeader(req.headers, "x-brevo-webhook-secret") ||
    getQueryValue(req, "token");

  return providedSecret === secret;
};

const getBrevoContactByEmail = async (email: string, brevoApiKey: string): Promise<BrevoContact | undefined> => {
  const response = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { "api-key": brevoApiKey },
  });

  if (!response.ok) return undefined;

  return response.json().catch(() => undefined) as Promise<BrevoContact | undefined>;
};

const getStringAttribute = (contact: BrevoContact | undefined, name: string) => {
  const value = contact?.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
};

const createBrevoContact = async (payload: unknown) => {
  const brevoApiKey = getEnv("BREVO_API_KEY");
  if (!brevoApiKey) return undefined;

  const email = findFirstString(payload, ["EMAIL", "email"]);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;

  const listId = Number(getEnv("BREVO_STRATEGY_CALL_LIST_ID") || "7");
  if (!Number.isInteger(listId) || listId <= 0) return undefined;

  const firstName = findFirstString(payload, ["firstName", "first_name", "FIRSTNAME", "attendee_first_name"]);
  const lastName = findFirstString(payload, ["lastName", "last_name", "LASTNAME", "attendee_last_name"]);
  const normalizedEmail = email.trim().toLowerCase();
  const timestamp = new Date().toISOString();
  const existingContact = await getBrevoContactByEmail(normalizedEmail, brevoApiKey);
  const source = "Strategy Call Booking";
  const leadSource = "brevo_meetings_webhook";
  const existingSource = getStringAttribute(existingContact, "SOURCE");
  const existingLeadSource = getStringAttribute(existingContact, "LEAD_SOURCE");
  const previousHistory = getStringAttribute(existingContact, "SOURCE_HISTORY");
  const historyEntry = `${timestamp} | ${source} | ${leadSource} | /book-a-call`;

  const response = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": brevoApiKey,
    },
    body: JSON.stringify({
      email: normalizedEmail,
      attributes: {
        ...(firstName ? { FIRSTNAME: firstName } : {}),
        ...(lastName ? { LASTNAME: lastName } : {}),
        SOURCE: source,
        LEAD_SOURCE: leadSource,
        FIRST_SOURCE: getStringAttribute(existingContact, "FIRST_SOURCE") || existingSource || source,
        FIRST_LEAD_SOURCE:
          getStringAttribute(existingContact, "FIRST_LEAD_SOURCE") ||
          existingLeadSource ||
          leadSource,
        FIRST_SOURCE_TIMESTAMP: getStringAttribute(existingContact, "FIRST_SOURCE_TIMESTAMP") || timestamp,
        LAST_SOURCE: source,
        LAST_LEAD_SOURCE: leadSource,
        LAST_SOURCE_TIMESTAMP: timestamp,
        SOURCE_HISTORY: [previousHistory, historyEntry].filter(Boolean).join("\n").slice(-2000),
        WEBSITE_ROUTE: "/book-a-call",
        OFFER: "strategy-call",
        CONSENT_STATUS: "not_provided",
        CONSENT_TIMESTAMP: timestamp,
      },
      listIds: [listId],
      updateEnabled: true,
    }),
  });

  if (!response.ok) {
    throw new Error("Brevo rejected the booking contact.");
  }

  const contact = await response.clone().json().catch(() => ({})) as { id?: number | string };

  const listResponse = await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts/add`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": brevoApiKey,
    },
    body: JSON.stringify({ emails: [normalizedEmail] }),
  });

  if (!listResponse.ok) {
    const errorText = await listResponse.text();
    console.warn("Brevo booking list membership call failed after contact upsert", {
      listId,
      message: errorText.slice(0, 180),
    });
  }

  return contact.id || existingContact?.id || (await getBrevoContactByEmail(normalizedEmail, brevoApiKey))?.id;
};

const buildBookingNotificationRows = (payload: unknown, meetingParams: ReturnType<typeof getMeetingParams>) => {
  const firstName = findFirstString(payload, ["firstName", "first_name", "FIRSTNAME", "attendee_first_name"]);
  const lastName = findFirstString(payload, ["lastName", "last_name", "LASTNAME", "attendee_last_name"]);

  return [
    ["Source", "Strategy Call Booking"],
    ["Name", `${firstName || ""} ${lastName || ""}`.trim()],
    ["Email", findFirstString(payload, ["EMAIL", "email"])],
    ["Meeting", meetingParams.meeting_name],
    ["Booking ID", meetingParams.booking_id],
    ["Start", meetingParams.meeting_start_timestamp],
    ["End", meetingParams.meeting_end_timestamp],
    ["Location", meetingParams.meeting_location],
    ["Page", meetingParams.page_location],
  ].filter(([, value]) => String(value || "").trim().length > 0);
};

const createBookingCrmHandoff = async (
  payload: unknown,
  meetingParams: ReturnType<typeof getMeetingParams>,
  contactId: number | string | undefined,
) => {
  const brevoApiKey = getEnv("BREVO_API_KEY");
  if (!brevoApiKey || !contactId) return;

  const firstName = findFirstString(payload, ["firstName", "first_name", "FIRSTNAME", "attendee_first_name"]);
  const lastName = findFirstString(payload, ["lastName", "last_name", "LASTNAME", "attendee_last_name"]);
  const email = findFirstString(payload, ["EMAIL", "email"]);
  const displayName = `${firstName || ""} ${lastName || ""}`.trim() || email || "Strategy call lead";
  const descriptionRows = buildBookingNotificationRows(payload, meetingParams)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  const dealResponse = await fetch("https://api.brevo.com/v3/crm/deals", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": brevoApiKey },
    body: JSON.stringify({
      name: `${displayName} - Strategy call`,
      attributes: {
        deal_owner: crmConfig.ownerId,
        pipeline: crmConfig.pipelineId,
        deal_stage: crmConfig.demoScheduledStageId,
        deal_description: descriptionRows,
        ...getBookingDealReportingAttributes(meetingParams),
      },
      linkedContactsIds: [Number(contactId)],
    }),
  });

  if (!dealResponse.ok) {
    const errorText = await dealResponse.text();
    throw new Error(`Brevo CRM booking deal creation failed. ${errorText.slice(0, 180)}`);
  }

  const deal = await dealResponse.json().catch(() => ({})) as { id?: number | string };
  const taskResponse = await fetch("https://api.brevo.com/v3/crm/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": brevoApiKey },
    body: JSON.stringify({
      name: `Prepare for strategy call - ${displayName}`,
      date: getCallPrepDueDateIso(meetingParams),
      taskTypeId: crmConfig.taskTypeId,
      assignToId: crmConfig.ownerId,
      contactsIds: [Number(contactId)],
      dealsIds: deal.id ? [deal.id] : [],
      notes: "Review booking context before the strategy call.",
      done: false,
    }),
  });

  if (!taskResponse.ok) {
    const errorText = await taskResponse.text();
    throw new Error(`Brevo CRM booking task creation failed. ${errorText.slice(0, 180)}`);
  }
};

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sendBookingInternalNotification = async (payload: unknown, meetingParams: ReturnType<typeof getMeetingParams>) => {
  const brevoApiKey = getEnv("BREVO_API_KEY");
  if (!brevoApiKey) return;

  const rows = buildBookingNotificationRows(payload, meetingParams);
  const textContent = ["Strategy call booking", "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const htmlRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-weight: 700;">${escapeHtml(label)}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(value)}</td>
    </tr>`).join("");

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": brevoApiKey },
    body: JSON.stringify({
      sender: { name: "AlphaTrack Digital", email: "sales@alphatrack.digital" },
      to: [{ email: "sales@alphatrack.digital" }, { email: "martech@alphatrack.digital" }],
      replyTo: { email: "sales@alphatrack.digital", name: "AlphaTrack Digital" },
      subject: "New strategy call booking",
      htmlContent: `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111827; line-height: 1.5;">
          <h1 style="font-size: 20px; margin: 0 0 16px;">Strategy call booking</h1>
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 720px; border: 1px solid #e5e7eb;">
            ${htmlRows}
          </table>
        </div>`,
      textContent,
      tags: ["brevo_meetings_webhook"],
    }),
  });

  if (!response.ok) {
    throw new Error("Brevo rejected the booking notification email.");
  }
};

const sendGa4Event = async (payload: unknown, meetingParams?: ReturnType<typeof getMeetingParams>) => {
  const measurementId = getEnv("GA4_MEASUREMENT_ID");
  const apiSecret = getEnv("GA4_MEASUREMENT_PROTOCOL_API_SECRET");

  if (!measurementId || !apiSecret) {
    throw new Error("GA4 Measurement Protocol is not configured.");
  }

  const eventName = getEnv("GA4_MEETING_BOOKED_EVENT_NAME") || DEFAULT_EVENT_NAME;
  const params = meetingParams || getMeetingParams(payload);
  const debugMode = getEnv("GA4_MEASUREMENT_PROTOCOL_DEBUG_MODE") === "true";

  const response = await fetch(
    `${GA4_COLLECT_ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: getClientId(payload),
        non_personalized_ads: true,
        events: [
          {
            name: eventName,
            params: {
              ...params,
              ...(debugMode ? { debug_mode: true } : {}),
            },
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    throw new Error("GA4 rejected the booking event.");
  }

  console.info("Brevo meeting booking sent to GA4.", {
    event_name: eventName,
    booking_id: params.booking_id,
    session_id: params.session_id,
    debug_mode: debugMode,
  });
};

const sendMetaBookingEvent = async (
  payload: unknown,
  req: Req,
  meetingParams: ReturnType<typeof getMeetingParams>,
) => {
  const pixelId = getEnv("META_PIXEL_ID");
  const accessToken = getEnv("META_CAPI_ACCESS_TOKEN");

  if (!pixelId || !accessToken) {
    console.info("Meta CAPI is not configured; skipping booking event.", {
      booking_id: meetingParams.booking_id,
    });
    return;
  }

  const graphVersion = getEnv("META_GRAPH_API_VERSION") || "v23.0";
  const testEventCode = getEnv("META_CAPI_TEST_EVENT_CODE");
  const email = findFirstString(payload, ["EMAIL", "email"]);
  const firstName = findFirstString(payload, ["firstName", "first_name", "FIRSTNAME", "attendee_first_name"]);
  const lastName = findFirstString(payload, ["lastName", "last_name", "LASTNAME", "attendee_last_name"]);
  const userAgent = getHeader(req.headers, "user-agent") || "";
  const forwarded = getHeader(req.headers, "x-forwarded-for");
  const clientIp = forwarded?.split(",")[0]?.trim() || "";

  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            event_name: "Schedule",
            event_time: Math.floor(Date.now() / 1000),
            event_id: `booking-${meetingParams.booking_id}`,
            action_source: "website",
            event_source_url: meetingParams.page_location,
            user_data: {
              ...(email ? { em: [sha256(email)] } : {}),
              ...(firstName ? { fn: [sha256(firstName)] } : {}),
              ...(lastName ? { ln: [sha256(lastName)] } : {}),
              ...(clientIp ? { client_ip_address: clientIp } : {}),
              ...(userAgent ? { client_user_agent: userAgent } : {}),
            },
            custom_data: {
              lead_source: "brevo_meetings_webhook",
              content_name: "Strategy call booking",
              booking_id: meetingParams.booking_id,
            },
          },
        ],
        ...(testEventCode ? { test_event_code: testEventCode } : {}),
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta CAPI rejected the booking event. ${errorText.slice(0, 180)}`);
  }
};

const handler = async (req: Req, res: Res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  if (!authenticate(req)) {
    return res.status(401).json({ ok: false, message: "Unauthorized webhook request." });
  }

  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ ok: false, message: "Invalid JSON payload." });
  }

  if (shouldIgnorePayload(req.body)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const meetingParams = getMeetingParams(req.body);
  const dedupeKey = buildBookingDedupeKey(meetingParams);
  const existingBooking = await getIdempotencyRecord(dedupeKey);
  const isDuplicate = Boolean(existingBooking);

  try {
    const [ga4Result, metaResult, brevoResult, notificationResult] = await Promise.allSettled([
      isDuplicate ? Promise.resolve() : sendGa4Event(req.body, meetingParams),
      isDuplicate ? Promise.resolve() : sendMetaBookingEvent(req.body, req, meetingParams),
      createBrevoContact(req.body)
        .then((contactId) => (isDuplicate ? undefined : createBookingCrmHandoff(req.body, meetingParams, contactId)))
        .catch(() => null),
      isDuplicate ? Promise.resolve() : sendBookingInternalNotification(req.body, meetingParams),
    ]);

    if (ga4Result.status === "rejected") {
      const message =
        ga4Result.reason instanceof Error ? ga4Result.reason.message : "Unable to track booking.";
      console.error("Brevo meeting booking GA4 tracking failed.", { message });
      return res.status(500).json({ ok: false, message });
    }

    if (metaResult.status === "rejected") {
      const message =
        metaResult.reason instanceof Error ? metaResult.reason.message : "Unable to track booking in Meta.";
      console.error("Brevo meeting booking Meta CAPI tracking failed.", { message });
    }

    if (!isDuplicate) {
      await markIdempotencyKey(dedupeKey, {
        source: "brevo_meetings_webhook",
        bookingId: meetingParams.booking_id,
      });
    }

    if (notificationResult.status === "rejected") {
      const message =
        notificationResult.reason instanceof Error ? notificationResult.reason.message : "Unable to send booking notification.";
      console.error("Brevo meeting booking notification failed.", { message });
    }

    return res.status(200).json({ ok: true, crm: brevoResult.status === "fulfilled", duplicate: isDuplicate });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to track booking.";
    console.error("Brevo meeting booking GA4 tracking failed.", { message });
    return res.status(500).json({ ok: false, message });
  }
};

export default handler;
