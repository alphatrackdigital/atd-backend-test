const defaultAllowedOrigins = new Set([
  "https://alphatrack.digital",
  "https://www.alphatrack.digital",
  "https://alphatrackdigital.netlify.app",
  "https://website-internal-test.vercel.app",
  "https://atd-website-test.vercel.app",
]);

function isAllowedOrigin(origin?: string) {
  if (!origin) return false;

  const configuredOrigins = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (defaultAllowedOrigins.has(origin) || configuredOrigins.includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && (
      hostname.endsWith("-alphatrackdigitals-projects.vercel.app") ||
      hostname.endsWith("--alphatrackdigital.netlify.app")
    );
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

  if (isAllowedOrigin(origin)) {
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
