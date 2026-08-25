import legacyHandler from "./lib/legacy-leads.mjs";
import trackingAuditHandler from "./lib/tracking-audit-handler.mjs";

export default async (request) => {
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
