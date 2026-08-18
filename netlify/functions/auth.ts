import type { Handler, HandlerEvent } from "@netlify/functions";
import bcrypt from "bcryptjs";
import { connectDB } from "./lib/db";
import { AdminUser } from "./lib/models/AdminUser";
import { signAdminToken } from "./lib/jwt";
import { corsHeaders, jsonResponse } from "./lib/http";
import {
  checkLoginThrottle,
  clearLoginFailures,
  loginThrottleKey,
  recordLoginFailure,
} from "./lib/loginThrottle";

export const handler: Handler = async (event: HandlerEvent) => {
  const headers = corsHeaders(event.headers["origin"]);

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405, headers);
  }

  let body: { email?: string; password?: string };
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse({ ok: false, message: "Invalid JSON." }, 400, headers);
  }

  const { email, password } = body;

  if (!email || !password) {
    return jsonResponse({ ok: false, message: "Email and password are required." }, 400, headers);
  }

  const clientIp = String(
    event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "unknown"
  ).split(",")[0].trim();
  const throttleKey = loginThrottleKey(clientIp, email);
  const throttle = checkLoginThrottle(throttleKey);
  if (!throttle.allowed) {
    return jsonResponse(
      { ok: false, message: "Too many login attempts. Please try again later." },
      429,
      { ...headers, "Retry-After": String(throttle.retryAfterSeconds) }
    );
  }

  try {
    await connectDB();

    // Look up admin by email
    const admin = await AdminUser.findOne({ email: email.toLowerCase() }).select("+passwordHash");

    // Always run bcrypt compare to prevent timing attacks (even if admin not found)
    const dummyHash = "$2a$12$invalidhashpadding000000000000000000000000000000000000";
    const passwordMatch = await bcrypt.compare(password, admin?.passwordHash ?? dummyHash);

    if (!admin || !passwordMatch) {
      const failedAttempt = recordLoginFailure(throttleKey);
      if (!failedAttempt.allowed) {
        return jsonResponse(
          { ok: false, message: "Too many login attempts. Please try again later." },
          429,
          { ...headers, "Retry-After": String(failedAttempt.retryAfterSeconds) }
        );
      }
      return jsonResponse({ ok: false, message: "Invalid credentials." }, 401, headers);
    }

    clearLoginFailures(throttleKey);
    const token = signAdminToken(admin.email);
    return jsonResponse({ ok: true, token }, 200, headers);
  } catch (err) {
    console.error("[auth] Error:", err);
    return jsonResponse({ ok: false, message: "Internal server error." }, 500, headers);
  }
};
