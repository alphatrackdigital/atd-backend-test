import type { VercelRequest, VercelResponse } from "@vercel/node";
import { connectDB } from "../../_lib/db";
import { Contact } from "../../_lib/models/Contact";
import { verifyAdminToken } from "../../_lib/jwt";
import { setCorsHeaders } from "../../_lib/http";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed." });

  const authHeader = String(req.headers["authorization"] || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  try {
    if (!token) throw new Error("No token");
    verifyAdminToken(token);
  } catch {
    return res.status(401).json({ ok: false, message: "Unauthorised." });
  }

  try {
    await connectDB();

    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Number(req.query.limit ?? 50));
    const source = req.query.source as string | undefined;

    const filter: Record<string, unknown> = {};
    if (source === "contact_form" || source === "tracking_audit_offer") {
      filter.source = source;
    }

    const [contacts, total] = await Promise.all([
      Contact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Contact.countDocuments(filter),
    ]);

    return res.status(200).json({ ok: true, contacts, total, page, limit });
  } catch (err) {
    console.error("[contacts-admin] Error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error." });
  }
}
