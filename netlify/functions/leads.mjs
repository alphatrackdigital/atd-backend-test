import legacyHandler from "./lib/legacy-leads.mjs";
import trackingAuditHandler from "./lib/tracking-audit-handler.mjs";

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

export default async (request) => {
  if (!isQaOverlayRequestAllowed(request)) return qaDenied();

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
