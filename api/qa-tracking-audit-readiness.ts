import type { VercelRequest, VercelResponse } from "@vercel/node";
import mongoose from "mongoose";
import { connectDB } from "./_lib/db";

type CheckState = "ok" | "missing" | "unreachable";

const checkBrevo = async (): Promise<CheckState> => {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) return "missing";

  try {
    const [account, auditList] = await Promise.all([
      fetch("https://api.brevo.com/v3/account", { headers: { "api-key": apiKey } }),
      fetch(`https://api.brevo.com/v3/contacts/lists/${encodeURIComponent(process.env.BREVO_AUDIT_LIST_ID || "11")}`, {
        headers: { "api-key": apiKey },
      }),
    ]);
    return account.ok && auditList.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
};

const checkMongo = async (): Promise<CheckState> => {
  if (!process.env.MONGODB_URI?.trim()) return "missing";
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return "unreachable";
    const result = await db.admin().ping();
    return result?.ok === 1 ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
};

const checkMeta = async (): Promise<CheckState> => {
  const pixelId = process.env.META_PIXEL_ID?.trim();
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN?.trim();
  if (!pixelId || !accessToken) return "missing";

  try {
    const version = process.env.META_GRAPH_API_VERSION?.trim() || "v23.0";
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("access_token", accessToken);
    const response = await fetch(url);
    return response.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false });
  }

  const [brevo, mongo, meta] = await Promise.all([checkBrevo(), checkMongo(), checkMeta()]);
  return res.status(200).json({
    ok: brevo === "ok" && mongo === "ok" && meta === "ok",
    checks: { brevo, mongo, meta },
  });
}
