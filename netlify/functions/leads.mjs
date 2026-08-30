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

const runDependencyProbe = async () => {
  const databaseName = "alphatrack_qa_tracking_audit";
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
