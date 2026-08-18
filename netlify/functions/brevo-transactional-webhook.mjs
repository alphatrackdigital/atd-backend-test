const json = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });

const getEnv = (name) => {
  if (globalThis.Netlify?.env?.get) {
    return globalThis.Netlify.env.get(name)?.trim();
  }

  if (typeof process !== "undefined") {
    return process.env[name]?.trim();
  }

  return undefined;
};

const getBearerToken = (authorization) => {
  const match = String(authorization || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
};

const authenticate = (request) => {
  const secret = getEnv("BREVO_TRANSACTIONAL_WEBHOOK_SECRET");
  if (!secret) return false;

  const url = new URL(request.url);
  const providedSecret =
    getBearerToken(request.headers.get("authorization")) ||
    request.headers.get("x-atd-webhook-secret") ||
    request.headers.get("x-brevo-webhook-secret") ||
    url.searchParams.get("token");

  return providedSecret === secret;
};

const asEvents = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.events)) return payload.events;
  return [payload];
};

const safeString = (value) => (typeof value === "string" ? value.trim() : "");

const summarizeEvents = (events) => {
  const byEvent = {};
  const byTag = {};

  for (const event of events) {
    if (!event || typeof event !== "object") continue;

    const eventName = safeString(event.event) || safeString(event.type) || "unknown";
    byEvent[eventName] = (byEvent[eventName] || 0) + 1;

    const tags = Array.isArray(event.tags) ? event.tags : [event.tag];
    for (const tag of tags) {
      const tagName = safeString(tag);
      if (tagName) byTag[tagName] = (byTag[tagName] || 0) + 1;
    }
  }

  return { byEvent, byTag };
};

export default async (request) => {
  if (request.method !== "POST") {
    return json(
      { ok: false, message: "Method not allowed" },
      { status: 405, headers: { allow: "POST" } },
    );
  }

  if (!authenticate(request)) {
    return json({ ok: false, message: "Unauthorized webhook request." }, { status: 401 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON payload." }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return json({ ok: false, message: "Invalid JSON payload." }, { status: 400 });
  }

  const events = asEvents(payload).filter((event) => event && typeof event === "object");
  const summary = summarizeEvents(events);

  console.info("Brevo transactional webhook received.", {
    count: events.length,
    ...summary,
  });

  return json({ ok: true, received: events.length, ...summary });
};

export const config = {
  path: "/api/brevo-transactional-webhook",
};
