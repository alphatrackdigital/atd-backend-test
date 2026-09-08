import { hasDisallowedBrowserOrigin, isAllowedBrowserOrigin } from "./lib/origin-policy.mjs";

const getEnv = (name) => {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  if (typeof process !== "undefined") return process.env[name];
  return undefined;
};

const json = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, max-age=3600",
      ...(init.headers ?? {}),
    },
  });

const getCorsHeaders = (request) => {
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
  if (isAllowedBrowserOrigin(origin, getEnv("CONTEXT"), getEnv("ALLOWED_ORIGINS"))) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return headers;
};

const normalizeCountryCode = (value) => {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

export default async (request, context = {}) => {
  const cors = getCorsHeaders(request);

  if (request.method === "OPTIONS") {
    if (hasDisallowedBrowserOrigin(request, getEnv("CONTEXT"), getEnv("ALLOWED_ORIGINS"))) {
      return json({ ok: false, message: "Origin not allowed" }, { status: 403, headers: cors });
    }
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "GET") {
    return json({ ok: false, message: "Method not allowed" }, { status: 405, headers: cors });
  }

  if (hasDisallowedBrowserOrigin(request, getEnv("CONTEXT"), getEnv("ALLOWED_ORIGINS"))) {
    return json({ ok: false, message: "Origin not allowed" }, { status: 403, headers: cors });
  }

  const countryCode = normalizeCountryCode(context?.geo?.country?.code);
  return json({ ok: true, countryCode }, { headers: cors });
};
