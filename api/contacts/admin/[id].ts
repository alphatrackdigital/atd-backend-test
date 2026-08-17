import type { VercelRequest, VercelResponse } from "@vercel/node";
import { connectDB } from "../../_lib/db";
import { Contact } from "../../_lib/models/Contact";
import { verifyAdminToken } from "../../_lib/jwt";
import { setCorsHeaders } from "../../_lib/http";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "DELETE") return res.status(405).json({ ok: false, message: "Method not allowed." });

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

    const id = req.query.id as string;
    const contact = await Contact.findByIdAndDelete(id);
    if (!contact) return res.status(404).json({ ok: false, message: "Not found." });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[contacts-admin] Error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error." });
  }
}
