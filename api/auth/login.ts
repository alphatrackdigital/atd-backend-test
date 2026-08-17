import type { VercelRequest, VercelResponse } from "@vercel/node";
import bcrypt from "bcryptjs";
import { connectDB } from "../_lib/db";
import { AdminUser } from "../_lib/models/AdminUser";
import { signAdminToken } from "../_lib/jwt";
import { setCorsHeaders } from "../_lib/http";
import {
  checkLoginThrottle,
  clearLoginFailures,
  loginThrottleKey,
  recordLoginFailure,
} from "../_lib/loginThrottle";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "Method not allowed." });

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Email and password are required." });
  }

  const clientIp = String(
    req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown"
  ).split(",")[0].trim();
  const throttleKey = loginThrottleKey(clientIp, String(email));
  const throttle = checkLoginThrottle(throttleKey);
  if (!throttle.allowed) {
    res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
    return res.status(429).json({ ok: false, message: "Too many login attempts. Please try again later." });
  }

  try {
    await connectDB();

    const admin = await AdminUser.findOne({ email: String(email).toLowerCase() }).select("+passwordHash");
    const dummyHash = "$2a$12$invalidhashpadding000000000000000000000000000000000000";
    const passwordMatch = await bcrypt.compare(String(password), admin?.passwordHash ?? dummyHash);

    if (!admin || !passwordMatch) {
      const failedAttempt = recordLoginFailure(throttleKey);
      if (!failedAttempt.allowed) {
        res.setHeader("Retry-After", String(failedAttempt.retryAfterSeconds));
        return res.status(429).json({ ok: false, message: "Too many login attempts. Please try again later." });
      }
      return res.status(401).json({ ok: false, message: "Invalid credentials." });
    }

    clearLoginFailures(throttleKey);
    const token = signAdminToken(admin.email);
    return res.status(200).json({ ok: true, token });
  } catch (err) {
    console.error("[auth] Error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error." });
  }
}
