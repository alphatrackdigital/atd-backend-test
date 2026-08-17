import type { VercelRequest, VercelResponse } from "@vercel/node";

const defaultAllowedOrigins = new Set([
  "https://alphatrack.digital",
  "https://www.alphatrack.digital",
  "https://alphatrackdigital.netlify.app",
  "https://website-internal-test.vercel.app",
  "https://atd-website-test.vercel.app",
]);

const isAllowedOrigin = (origin: string) => {
  const configuredOrigins = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (defaultAllowedOrigins.has(origin) || configuredOrigins.includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && hostname.endsWith("-alphatrackdigitals-projects.vercel.app");
  } catch {
    return false;
  }
};

export function setCorsHeaders(req: VercelRequest, res: VercelResponse): void {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}
