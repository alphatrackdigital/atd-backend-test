import type { VercelRequest, VercelResponse } from "@vercel/node";

import { setCorsHeaders } from "./_lib/http";

const normalizeCountryCode = (value: string | string[] | undefined): string | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

export default function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);
  res.setHeader("Cache-Control", "private, max-age=3600");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const countryCode = normalizeCountryCode(req.headers["x-vercel-ip-country"]);
  return res.status(200).json({ ok: true, countryCode });
}
