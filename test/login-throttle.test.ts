import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkLoginThrottle as checkVercel,
  clearLoginFailures as clearVercel,
  loginThrottleKey as vercelKey,
  recordLoginFailure as failVercel,
  resetLoginThrottleForTests as resetVercel,
} from "../api/_lib/loginThrottle";
import {
  checkLoginThrottle as checkNetlify,
  clearLoginFailures as clearNetlify,
  loginThrottleKey as netlifyKey,
  recordLoginFailure as failNetlify,
  resetLoginThrottleForTests as resetNetlify,
} from "../netlify/functions/lib/loginThrottle";

const implementations = [
  { name: "Vercel", check: checkVercel, clear: clearVercel, key: vercelKey, fail: failVercel, reset: resetVercel },
  { name: "Netlify", check: checkNetlify, clear: clearNetlify, key: netlifyKey, fail: failNetlify, reset: resetNetlify },
];

describe.each(implementations)("$name login throttle", ({ check, clear, key, fail, reset }) => {
  beforeEach(() => {
    process.env.ADMIN_LOGIN_MAX_FAILURES = "2";
    process.env.ADMIN_LOGIN_WINDOW_MINUTES = "1";
    reset();
  });

  afterEach(() => {
    delete process.env.ADMIN_LOGIN_MAX_FAILURES;
    delete process.env.ADMIN_LOGIN_WINDOW_MINUTES;
    reset();
  });

  it("normalizes and hashes the IP/email identity", () => {
    expect(key(" 203.0.113.4 ", " ADMIN@Example.com ")).toBe(
      key("203.0.113.4", "admin@example.com"),
    );
    expect(key("203.0.113.4", "admin@example.com")).not.toContain("admin@example.com");
  });

  it("blocks at the configured failure threshold and resets after the window", () => {
    const identity = key("203.0.113.4", "admin@example.com");
    expect(fail(identity, 1_000)).toMatchObject({ allowed: true });
    expect(fail(identity, 2_000)).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(check(identity, 61_999)).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(check(identity, 62_000)).toMatchObject({ allowed: true });
  });

  it("clears failures after a successful login", () => {
    const identity = key("203.0.113.4", "admin@example.com");
    fail(identity, 1_000);
    clear(identity);
    expect(check(identity, 2_000)).toMatchObject({ allowed: true });
  });
});
