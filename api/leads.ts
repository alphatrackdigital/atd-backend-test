import legacyHandler from "./_lib/legacyLeads";
import trackingAuditHandler from "./_lib/trackingAuditHandler";

type LegacyReq = Parameters<typeof legacyHandler>[0];
type LegacyRes = Parameters<typeof legacyHandler>[1];
type AuditReq = Parameters<typeof trackingAuditHandler>[0];
type AuditRes = Parameters<typeof trackingAuditHandler>[1];

const handler = async (req: LegacyReq, res: LegacyRes) => {
  const source = (req.body as { source?: string } | undefined)?.source;
  if (source === "tracking_audit_offer") {
    return trackingAuditHandler(req as unknown as AuditReq, res as unknown as AuditRes);
  }
  return legacyHandler(req, res);
};

export default handler;
