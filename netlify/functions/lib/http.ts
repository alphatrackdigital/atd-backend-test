const productionAllowedOrigins = new Set([
  "https://alphatrack.digital",
  "https://www.alphatrack.digital",
]);

const previewOriginSuffixes = [
  "-alphatrackdigitals-projects.vercel.app",
  "--alphatrackdigital.netlify.app",
];

function configuredOrigins() {
  return String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isProductionContext() {
  return process.env.CONTEXT === "production";
}

export function isAllowedBrowserOrigin(origin?: string) {
  if (!origin) return false;

  if (productionAllowedOrigins.has(origin)) return true;

  // Production is intentionally closed to canonical live origins only.
  // QA/test origins belong in ALLOWED_ORIGINS on non-production deploy contexts.
  if (isProductionContext()) return false;

  if (configuredOrigins().includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && previewOriginSuffixes.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

export function corsHeaders(origin?: string) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Content-Type": "application/json",
  };

  if (isAllowedBrowserOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin as string;
    headers.Vary = "Origin";
  }

  return headers;
}

export function jsonResponse(
  body: unknown,
  statusCode: number,
  headers: Record<string, string> = {}
) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
