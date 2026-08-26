import type { VercelRequest, VercelResponse } from "@vercel/node";
import mongoose from "mongoose";
import { buildLeadDedupeKey } from "./_lib/idempotency";
import { connectDB } from "./_lib/db";
import { Contact } from "./_lib/models/Contact";

const QA_EMAIL = "qa-tracking-audit-20260826-1554@alphatrack.digital";
const QA_WEBSITE = "https://alphatrack.digital/qa/tracking-audit-e2e-20260826-1554";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false });
  }

  await connectDB();
  const db = mongoose.connection.db;
  if (!db) return res.status(500).json({ ok: false, message: "Database unavailable" });

  const dedupeKey = buildLeadDedupeKey({
    source: "tracking_audit_offer",
    email: QA_EMAIL,
    websiteUrl: QA_WEBSITE,
  });

  const contacts = await Contact.deleteMany({ email: QA_EMAIL });
  const idempotency = await db.collection("idempotencyrecords").deleteMany({
    key: { $regex: `^${escapeRegExp(dedupeKey)}` },
  });

  return res.status(200).json({
    ok: true,
    database: mongoose.connection.name,
    deletedContacts: contacts.deletedCount,
    deletedIdempotency: idempotency.deletedCount,
  });
}
