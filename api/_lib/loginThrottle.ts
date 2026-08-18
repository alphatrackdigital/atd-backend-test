import { createHash } from "node:crypto";

type LoginAttempt = {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
};

const attempts = new Map<string, LoginAttempt>();
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const settings = () => ({
  maxFailures: positiveInteger(process.env.ADMIN_LOGIN_MAX_FAILURES, DEFAULT_MAX_FAILURES),
  windowMs: positiveInteger(process.env.ADMIN_LOGIN_WINDOW_MINUTES, 15) * 60 * 1000,
});

export const loginThrottleKey = (ip: string, email: string) =>
  createHash("sha256")
    .update(`${ip.trim().toLowerCase()}:${email.trim().toLowerCase()}`)
    .digest("hex");

export const checkLoginThrottle = (key: string, now = Date.now()) => {
  const attempt = attempts.get(key);
  if (!attempt) return { allowed: true, retryAfterSeconds: 0 };

  if (attempt.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((attempt.blockedUntil - now) / 1000)),
    };
  }

  const { windowMs } = settings();
  if (now - attempt.windowStartedAt >= windowMs) attempts.delete(key);
  return { allowed: true, retryAfterSeconds: 0 };
};

export const recordLoginFailure = (key: string, now = Date.now()) => {
  const { maxFailures, windowMs } = settings();
  const current = attempts.get(key);
  const attempt = !current || now - current.windowStartedAt >= windowMs
    ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
    : current;

  attempt.failures += 1;
  if (attempt.failures >= maxFailures) attempt.blockedUntil = now + windowMs;
  attempts.set(key, attempt);
  return checkLoginThrottle(key, now);
};

export const clearLoginFailures = (key: string) => attempts.delete(key);

export const resetLoginThrottleForTests = () => attempts.clear();
