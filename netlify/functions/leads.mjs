import legacyHandler from "./lib/legacy-leads.mjs";
import trackingAuditHandler from "./lib/tracking-audit-handler.mjs";
import { reserveTrackingAuditMetaEventId } from "./lib/idempotency.mjs";

const QA_OVERLAY_ORIGIN = "https://atd-website-qa.alphatrackdigital.workers.dev";
const QA_PROXY_MARKER = "tracking-audit-e2e";

const isQaOverlayRequestAllowed = (request) => {
  if (process.env.VITEST) return true;
  return (
    request.headers.get("x-atd-qa-proxy") === QA_PROXY_MARKER &&
    request.headers.get("origin") === QA_OVERLAY_ORIGIN
  );
};

const qaDenied = () =>
  new Response(JSON.stringify({ ok: false, message: "QA route not allowed." }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const getEnv = (name) => {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  if (typeof process !== "undefined") return process.env[name];
  return undefined;
};

const qaJson = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const UAT_TEST_EMAIL = "alphatrackdigital+tracking-audit-dedupe-uat-20260831@gmail.com";

const getBrevoJson = async (url, apiKey) => {
  const response = await fetch(url, {
    headers: { "api-key": apiKey, accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
};

const getBrevoEmailEvents = async (email, apiKey) => {
  const url = new URL("https://api.brevo.com/v3/smtp/statistics/events");
  url.searchParams.set("days", "1");
  url.searchParams.set("email", email);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort", "desc");
  const result = await getBrevoJson(url, apiKey);
  const events = Array.isArray(result.body?.events) ? result.body.events : [];
  return {
    ok: result.ok,
    status: result.status,
    events: events.map((event) => ({
      event: event.event,
      tag: event.tag,
      date: event.date,
    })),
  };
};

const runUatRecordProbe = async () => {
  const apiKey = getEnv("BREVO_API_KEY")?.trim();
  if (!apiKey) return qaJson({ ok: false, message: "Brevo is not configured." }, 503);

  const contactResult = await getBrevoJson(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(UAT_TEST_EMAIL)}`,
    apiKey,
  );
  if (!contactResult.ok) {
    return qaJson({ ok: false, contactStatus: contactResult.status }, 503);
  }

  const contact = contactResult.body || {};
  const contactId = Number(contact.id);
  const taskUrl = new URL("https://api.brevo.com/v3/crm/tasks");
  taskUrl.searchParams.set("filter[contacts]", String(contactId));
  taskUrl.searchParams.set("limit", "50");
  taskUrl.searchParams.set("sort", "desc");
  const taskResult = await getBrevoJson(taskUrl, apiKey);
  const tasks = Array.isArray(taskResult.body?.items) ? taskResult.body.items : [];
  const matchingTasks = tasks.filter((task) =>
    String(task.name || "").startsWith("Review tracking audit application -"),
  );

  const [applicantEvents, auditEvents, martechEvents] = await Promise.all([
    getBrevoEmailEvents(UAT_TEST_EMAIL, apiKey),
    getBrevoEmailEvents("audit@alphatrack.digital", apiKey),
    getBrevoEmailEvents("martech@alphatrack.digital", apiKey),
  ]);

  const a = contact.attributes || {};
  const selectedAttributes = {
    FIRSTNAME: a.FIRSTNAME,
    LASTNAME: a.LASTNAME,
    COMPANY: a.COMPANY,
    WEBSITE: a.WEBSITE,
    WEBSITE_URL: a.WEBSITE_URL,
    AD_PLATFORMS: a.AD_PLATFORMS,
    AUDIT_INDUSTRY: a.AUDIT_INDUSTRY,
    AUDIT_ROLE: a.AUDIT_ROLE,
    AUDIT_DECISION_INFLUENCE: a.AUDIT_DECISION_INFLUENCE,
    AUDIT_AD_SPEND_BAND: a.AUDIT_AD_SPEND_BAND,
    AUDIT_PAID_CHANNELS: a.AUDIT_PAID_CHANNELS,
    AUDIT_TRACKING_MATURITY: a.AUDIT_TRACKING_MATURITY,
    AUDIT_PRIMARY_CONVERSION: a.AUDIT_PRIMARY_CONVERSION,
    AUDIT_MEASUREMENT_PROBLEM: a.AUDIT_MEASUREMENT_PROBLEM,
    AUDIT_URGENCY: a.AUDIT_URGENCY,
    AUDIT_STATUS: a.AUDIT_STATUS,
    AUDIT_HANDOFF_STATUS: a.AUDIT_HANDOFF_STATUS,
    LEAD_SOURCE: a.LEAD_SOURCE,
    SOURCE: a.SOURCE,
    FIRST_SOURCE: a.FIRST_SOURCE,
    LAST_SOURCE: a.LAST_SOURCE,
    LAST_LEAD_SOURCE: a.LAST_LEAD_SOURCE,
    WEBSITE_ROUTE: a.WEBSITE_ROUTE,
    OFFER: a.OFFER,
    CONSENT_STATUS: a.CONSENT_STATUS,
    UTM_SOURCE: a.UTM_SOURCE,
    UTM_MEDIUM: a.UTM_MEDIUM,
    UTM_CAMPAIGN: a.UTM_CAMPAIGN,
    UTM_CONTENT: a.UTM_CONTENT,
    FBCLID: a.FBCLID,
    LANDING_PAGE: a.LANDING_PAGE,
  };

  return qaJson({
    ok: true,
    contact: {
      id: contact.id,
      email: contact.email,
      listIds: contact.listIds,
      attributes: selectedAttributes,
    },
    tasks: {
      apiOk: taskResult.ok,
      status: taskResult.status,
      count: matchingTasks.length,
      items: matchingTasks.map((task) => ({
        id: task.id,
        name: task.name,
        date: task.date,
        done: task.done,
        contactsIds: task.contactsIds,
        dealsIds: task.dealsIds,
        assignToId: task.assignToId,
        taskTypeId: task.taskTypeId,
        notes: task.notes,
      })),
    },
    emailEvents: {
      applicant: applicantEvents,
      audit: auditEvents,
      martech: martechEvents,
    },
  });
};

const runUatCleanup = async () => {
  const apiKey = getEnv("BREVO_API_KEY")?.trim();
  if (!apiKey) return qaJson({ ok: false, message: "Brevo is not configured." }, 503);

  const taskIds = [
    "6a94c31858cc954e34311a77",
    "6a94c4aa58cc954e34311b26",
  ];
  const emails = [
    "alphatrackdigital+tracking-audit-uat-20260831-01@gmail.com",
    "alphatrackdigital+tracking-audit-dedupe-uat-20260831@gmail.com",
  ];

  const deleteFixed = async (url) => {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { "api-key": apiKey, accept: "application/json" },
    });
    return { ok: response.ok || response.status === 404, status: response.status };
  };

  const taskResults = [];
  for (const id of taskIds) {
    taskResults.push({ id, ...(await deleteFixed(`https://api.brevo.com/v3/crm/tasks/${id}`)) });
  }

  const contactResults = [];
  for (const email of emails) {
    contactResults.push({
      email,
      ...(await deleteFixed(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`)),
    });
  }

  const ok = [...taskResults, ...contactResults].every((result) => result.ok);
  return qaJson({ ok, taskResults, contactResults }, ok ? 200 : 502);
};

const runDependencyProbe = async () => {
  const databaseName = "alphatrack_tracking_audit_qa";
  const mongoUri = getEnv("MONGODB_URI")?.trim();
  const brevoApiKey = getEnv("BREVO_API_KEY")?.trim();
  const metaConfigured = Boolean(getEnv("META_CAPI_ACCESS_TOKEN")?.trim());

  let mongoOk = false;
  if (mongoUri) {
    try {
      const probeKey = "qa-probe/tracking-audit/dependency";
      const reserved = await reserveTrackingAuditMetaEventId(
        probeKey,
        "qa-probe-tracking-audit-dependency",
        { mongoUri, databaseName },
      );
      mongoOk = reserved === "qa-probe-tracking-audit-dependency";
    } catch {
      mongoOk = false;
    }
  }

  let brevoStatus = 0;
  let brevoOk = false;
  if (brevoApiKey) {
    try {
      const response = await fetch("https://api.brevo.com/v3/account", {
        headers: { "api-key": brevoApiKey, accept: "application/json" },
      });
      brevoStatus = response.status;
      brevoOk = response.ok;
    } catch {
      brevoStatus = 0;
      brevoOk = false;
    }
  }

  return qaJson({
    ok: mongoOk && brevoOk && !metaConfigured,
    mongo: { configured: Boolean(mongoUri), ok: mongoOk, database: databaseName },
    brevo: { configured: Boolean(brevoApiKey), ok: brevoOk, status: brevoStatus },
    meta: { configured: metaConfigured },
  }, mongoOk && brevoOk && !metaConfigured ? 200 : 503);
};

export default async (request) => {
  if (!isQaOverlayRequestAllowed(request)) return qaDenied();

  const url = new URL(request.url);
  if (request.method === "GET" && url.searchParams.get("atd_qa_probe") === "dependencies") {
    return runDependencyProbe();
  }
  if (request.method === "GET" && url.searchParams.get("atd_qa_probe") === "uat_records") {
    return runUatRecordProbe();
  }
  if (request.method === "POST" && url.searchParams.get("atd_qa_cleanup") === "uat_records") {
    return runUatCleanup();
  }

  let source;
  try {
    source = (await request.clone().json())?.source;
  } catch {
    // Let the legacy handler return the canonical invalid-JSON response.
  }

  if (source === "tracking_audit_offer") {
    return trackingAuditHandler(request);
  }

  return legacyHandler(request);
};
