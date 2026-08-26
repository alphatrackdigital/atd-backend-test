import { createHash } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import { connectDB } from "./db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const memoryStore: Map<string, Record<string, unknown>> = (globalThis as any).__atdConversionIdempotency ?? new Map();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__atdConversionIdempotency = memoryStore;

interface AuditStepClaimRecord {
  key: string;
  status: "in_progress" | "completed";
  leaseUntil?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auditStepMemoryClaims: Map<string, { status: "in_progress" | "completed"; leaseUntil?: number }> =
  (globalThis as any).__atdAuditStepClaims ?? new Map();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__atdAuditStepClaims = auditStepMemoryClaims;

const IdempotencySchema = new Schema({
  key:       { type: String, required: true, unique: true },
  data:      { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
});

const AuditStepClaimSchema = new Schema<AuditStepClaimRecord>({
  key: { type: String, required: true, unique: true },
  status: { type: String, enum: ["in_progress", "completed"], required: true },
  leaseUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, expires: 0 },
});

const IdempotencyRecord =
  (mongoose.models.IdempotencyRecord as mongoose.Model<{ key: string; data?: unknown; createdAt: Date }>) ||
  mongoose.model("IdempotencyRecord", IdempotencySchema);

const AuditStepClaim =
  (mongoose.models.AuditStepClaim as mongoose.Model<AuditStepClaimRecord>) ||
  mongoose.model<AuditStepClaimRecord>("AuditStepClaim", AuditStepClaimSchema);

export const normalizeEmail = (value: unknown): string => String(value || "").trim().toLowerCase();

export const hashValue = (value: unknown): string =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

const normalizeString = (value: unknown): string => String(value || "").trim().toLowerCase();

const normalizeList = (value: unknown): string => {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;]+/)
      : [];
  return [...new Set(values.map(normalizeString).filter(Boolean))].sort().join(",");
};

const dayStamp = (date = new Date()): string => date.toISOString().slice(0, 10);

const safeKey = (parts: string[]): string =>
  parts.map((p) => String(p).replace(/[^a-zA-Z0-9._-]/g, "-")).join("/");

const trackingAuditApplicationFingerprint = (payload: Record<string, unknown>): string =>
  [
    normalizeEmail(payload.email),
    normalizeString(payload.websiteUrl),
    normalizeString(payload.firstName),
    normalizeString(payload.lastName),
    normalizeString(payload.company),
    normalizeString(payload.industry),
    normalizeString(payload.role),
    normalizeString(payload.decisionInfluence),
    normalizeString(payload.monthlyAdSpendBand || payload.monthlyAdSpend),
    normalizeList(payload.adPlatforms),
    normalizeString(payload.trackingMaturity),
    normalizeString(payload.primaryConversionType),
    normalizeString(payload.measurementProblem),
    normalizeString(payload.urgency),
    payload.optIn === true ? "opted_in" : "not_opted_in",
  ].join("|");

const isReplaySafeAuditStep = (key: string): boolean =>
  key.endsWith("/audit-mongo-persistence") || key.endsWith("/audit-meta-capi");

const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && Number((error as { code?: unknown }).code) === 11000;

export const getIdempotencyRecord = async (key: string): Promise<Record<string, unknown> | null> => {
  if (!key) return null;

  const memoryRecord = memoryStore.get(key);
  if (memoryRecord) return memoryRecord;

  try {
    await connectDB();
    const record = await IdempotencyRecord.findOne({ key }).lean();
    if (record) memoryStore.set(key, record as Record<string, unknown>);
    return (record as Record<string, unknown>) || null;
  } catch {
    return null;
  }
};

export const markIdempotencyKey = async (key: string, payload: Record<string, unknown> = {}): Promise<void> => {
  if (!key) return;
  const record = { ...payload, key, createdAt: new Date() };
  memoryStore.set(key, record);

  try {
    await connectDB();
    await IdempotencyRecord.updateOne({ key }, { $setOnInsert: record }, { upsert: true });
  } catch {
    // in-memory fallback still protects warm instances
  }
};

export const claimAuditStep = async (
  key: string,
  options: { leaseMs?: number; allowExpiredReclaim?: boolean } = {},
): Promise<boolean> => {
  if (!key) return false;
  const leaseMs = options.leaseMs ?? 60_000;
  const allowExpiredReclaim = options.allowExpiredReclaim ?? isReplaySafeAuditStep(key);
  const nowMs = Date.now();

  const memoryClaim = auditStepMemoryClaims.get(key);
  if (memoryClaim?.status === "completed") return false;
  if (memoryClaim?.status === "in_progress") {
    if (!allowExpiredReclaim || (memoryClaim.leaseUntil || 0) > nowMs) return false;
  }

  if (process.env.VITEST) {
    auditStepMemoryClaims.set(key, { status: "in_progress", leaseUntil: nowMs + leaseMs });
    return true;
  }

  if (!process.env.MONGODB_URI?.trim()) {
    throw new Error("Durable Tracking Audit step claims require MONGODB_URI.");
  }

  await connectDB();
  const now = new Date(nowMs);
  const leaseUntil = new Date(nowMs + leaseMs);
  const expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000);

  try {
    await AuditStepClaim.create({
      key,
      status: "in_progress",
      leaseUntil,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    auditStepMemoryClaims.set(key, { status: "in_progress", leaseUntil: leaseUntil.getTime() });
    return true;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  if (!allowExpiredReclaim) return false;

  const reclaimed = await AuditStepClaim.findOneAndUpdate(
    { key, status: "in_progress", leaseUntil: { $lte: now } },
    { $set: { leaseUntil, updatedAt: now, expiresAt } },
    { new: true },
  ).lean();
  if (reclaimed) {
    auditStepMemoryClaims.set(key, { status: "in_progress", leaseUntil: leaseUntil.getTime() });
  }
  return Boolean(reclaimed);
};

export const completeAuditStep = async (key: string): Promise<void> => {
  if (!key) return;
  if (process.env.VITEST) {
    auditStepMemoryClaims.set(key, { status: "completed" });
    return;
  }

  try {
    await connectDB();
    const now = new Date();
    await AuditStepClaim.updateOne(
      { key, status: "in_progress" },
      {
        $set: {
          status: "completed",
          leaseUntil: null,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      },
    );
    auditStepMemoryClaims.set(key, { status: "completed" });
  } catch (error) {
    console.error("Tracking Audit completion marker persistence failed; preserving the durable in-progress claim.", {
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const releaseAuditStep = async (key: string): Promise<void> => {
  if (!key) return;
  if (process.env.VITEST) {
    const existing = auditStepMemoryClaims.get(key);
    if (existing?.status === "in_progress") auditStepMemoryClaims.delete(key);
    return;
  }

  await connectDB();
  await AuditStepClaim.deleteOne({ key, status: "in_progress" });
  auditStepMemoryClaims.delete(key);
};

export const resetIdempotencyForTests = (): void => {
  if (process.env.VITEST) {
    memoryStore.clear();
    auditStepMemoryClaims.clear();
  }
};

export const buildLeadDedupeKey = (payload: Record<string, unknown>): string => {
  const source = normalizeString(payload?.source);
  const email = normalizeEmail(payload?.email);
  if (!source || !email) return "";

  if (source === "newsletter") {
    return safeKey(["lead", "newsletter", hashValue(email)]);
  }

  if (source === "tracking_audit_offer") {
    return safeKey([
      "lead",
      source,
      dayStamp(),
      hashValue(trackingAuditApplicationFingerprint(payload)),
    ]);
  }

  return safeKey(["lead", source, dayStamp(), hashValue(email)]);
};

export const buildExitPopupDedupeKey = (lead: { email: string }): string => {
  const email = normalizeEmail(lead?.email);
  return email ? safeKey(["lead", "exit_popup", hashValue(email)]) : "";
};

export const buildBookingDedupeKey = (params: { booking_id?: string }): string => {
  const bookingId = normalizeString(params?.booking_id);
  if (!bookingId) return "";
  return safeKey(["booking", hashValue(bookingId)]);
};
