const productionAllowedOrigins = new Set([
  "https://alphatrack.digital",
  "https://www.alphatrack.digital",
]);

const previewOriginSuffixes = [
  "-alphatrackdigitals-projects.vercel.app",
  "--alphatrackdigital.netlify.app",
];

const parseConfiguredOrigins = (value) =>
  String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const isAllowedBrowserOrigin = (origin, context, configuredOrigins) => {
  if (!origin) return false;
  if (productionAllowedOrigins.has(origin)) return true;
  if (context === "production") return false;
  if (parseConfiguredOrigins(configuredOrigins).includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && previewOriginSuffixes.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
};

export const hasDisallowedBrowserOrigin = (request, context, configuredOrigins) => {
  const origin = request.headers.get("origin");
  return Boolean(origin) && !isAllowedBrowserOrigin(origin, context, configuredOrigins);
};
