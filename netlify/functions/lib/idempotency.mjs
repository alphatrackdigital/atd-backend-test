import { createHash } from "node:crypto";
import mongoose from "mongoose";

const memoryStore = globalThis.__atdConversionIdempotency ?? new Map();
globalThis.__atdConversionIdempotency = memoryStore;
const auditStepMemoryClaims = globalThis.__atdAuditStepClaims ?? new Map();
globalThis.__atdAuditStepClaims = auditStepMemoryClaims;

const STORE_NAME = "atd-conversion-idempotency";
let testDurableStore;

const AuditStepClaimSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  status: { type: String, enum: ["in_progress", "completed"], required: true },
  leaseUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, expires: 0 },
});

const AuditStepClaim = mongoose.models.AuditStepClaim || mongoose.model("AuditStepClaim", AuditStepClaimSchema);

export class DurableIdempotencyError extends Error {
  constructor(message = "Durable idempotency storage is unavailable.") {
    super(message);
    this.name = "DurableIdempotencyError";
  }
}

export const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const normalizeString = (value) => String(value || "").trim().toLowerCase();

const normalizeList = (value) => {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;]+/)
      : [];
  return [...new Set(values.map(normalizeString).filter(Boolean))].sort().join(",");
};

export const hashValue = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

const dayStamp = (date = new Date()) => date.toISOString().slice(0, 10);

const safeKey = (parts) => parts.map((part) => String(part).replace(/[^a-zA-Z0-9._-]/g, "-")).join("/");

const trackingAuditApplicationFingerprint = (payload) =>
  [
    normalizeEmail(payload?.email),
    normalizeString(payload?.websiteUrl),
    normalizeString(payload?.firstName),
    normalizeString(payload?.lastName),
    normalizeString(payload?.company),
    normalizeString(payload?.industry),
    normalizeString(payload?.role),
    normalizeString(payload?.decisionInfluence),
    normalizeString(payload?.monthlyAdSpendBand || payload?.monthlyAdSpend),
    normalizeList(payload?.adPlatforms),
    normalizeString(payload?.trackingMaturity),
    normalizeString(payload?.primaryConversionType),
    normalizeString(payload?.measurementProblem),
    normalizeString(payload?.urgency),
    payload?.optIn === true ? "opted_in" : "not_opted_in",
  ].join("|");

const isReplaySafeAuditStep = (key) =>
  key.endsWith("/audit-mongo-persistence") || key.endsWith("/audit-meta-capi");

const getBlobStore = async () => {
  if (process.env.VITEST) return testDurableStore || null;

  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: STORE_NAME, consistency: "strong" });
  } catch {
    return null;
  }
};

const connectAuditStepStore = async (mongoUri, databaseName = "alphatrack") => {
  if (!mongoUri) throw new DurableIdempotencyError("Durable Tracking Audit step claims require MONGODB_URI.");
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri, { dbName: databaseName });
  }
};

const isDuplicateKeyError = (error) => Number(error?.code) === 11000;

export const getDurableIdempotencyRecord = async (key) => {
  if (!key) throw new DurableIdempotencyError("A durable idempotency key is required.");

  const store = await getBlobStore();
  if (!store) throw new DurableIdempotencyError();

  try {
    const record = await store.get(key, { type: "json" });
    if (record) memoryStore.set(key, record);
    return record || null;
  } catch {
    throw new DurableIdempotencyError();
  }
};

export const setDurableIdempotencyRecord = async (key, record) => {
  if (!key) throw new DurableIdempotencyError("A durable idempotency key is required.");

  const store = await getBlobStore();
  if (!store) throw new DurableIdempotencyError();

  const nextRecord = {
    ...record,
    key,
    updatedAt: new Date().toISOString(),
  };

  try {
    await store.setJSON(key, nextRecord);
    memoryStore.set(key, nextRecord);
    return nextRecord;
  } catch {
    throw new DurableIdempotencyError();
  }
};

export const getIdempotencyRecord = async (key) => {
  if (!key) return null;

  const memoryRecord = memoryStore.get(key);
  if (memoryRecord) return memoryRecord;

  const store = await getBlobStore();
  if (!store) return null;

  try {
    const record = await store.get(key, { type: "json" });
    if (record) memoryStore.set(key, record);
    return record || null;
  } catch {
    return null;
  }
};

export const markIdempotencyKey = async (key, payload = {}) => {
  if (!key) return;

  const record = {
    ...payload,
    key,
    createdAt: new Date().toISOString(),
  };

  memoryStore.set(key, record);

  const store = await getBlobStore();
  if (!store) return;

  try {
    await store.setJSON(key, record);
  } catch {
    // Memory fallback still protects warm function instances if Blob storage is unavailable.
  }
};

export const claimAuditStep = async (
  key,
  { mongoUri, databaseName = "alphatrack", leaseMs = 60_000, allowExpiredReclaim } = {},
) => {
  if (!key) return false;
  const reclaimExpired = allowExpiredReclaim ?? isReplaySafeAuditStep(key);
  const nowMs = Date.now();

  const memoryClaim = auditStepMemoryClaims.get(key);
  if (memoryClaim?.status === "completed") return false;
  if (memoryClaim?.status === "in_progress") {
    if (!reclaimExpired || (memoryClaim.leaseUntil || 0) > nowMs) return false;
  }

  if (process.env.VITEST) {
    auditStepMemoryClaims.set(key, { status: "in_progress", leaseUntil: nowMs + leaseMs });
    return true;
  }

  await connectAuditStepStore(mongoUri, databaseName);
  const now = new Date(nowMs);
  const leaseUntil = new Date(nowMs + leaseMs);
  const expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000);

  try {
    await AuditStepClaim.create({ key, status: "in_progress", leaseUntil, createdAt: now, updatedAt: now, expiresAt });
    auditStepMemoryClaims.set(key, { status: "in_progress", leaseUntil: leaseUntil.getTime() });
    return true;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  if (!reclaimExpired) return false;

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

export const completeAuditStep = async (key, { mongoUri, databaseName = "alphatrack" } = {}) => {
  if (!key) return;
  if (process.env.VITEST) {
    auditStepMemoryClaims.set(key, { status: "completed" });
    return;
  }

  try {
    await connectAuditStepStore(mongoUri, databaseName);
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

export const releaseAuditStep = async (key, { mongoUri, databaseName = "alphatrack" } = {}) => {
  if (!key) return;
  if (process.env.VITEST) {
    const existing = auditStepMemoryClaims.get(key);
    if (existing?.status === "in_progress") auditStepMemoryClaims.delete(key);
    return;
  }

  await connectAuditStepStore(mongoUri, databaseName);
  await AuditStepClaim.deleteOne({ key, status: "in_progress" });
  auditStepMemoryClaims.delete(key);
};

export const resetIdempotencyForTests = () => {
  if (process.env.VITEST) {
    memoryStore.clear();
    auditStepMemoryClaims.clear();
    testDurableStore = undefined;
  }
};

export const setDurableIdempotencyStoreForTests = (store) => {
  if (process.env.VITEST) testDurableStore = store;
};

export const buildLeadDedupeKey = (payload) => {
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

export const buildExitPopupDedupeKey = (lead) => {
  const email = normalizeEmail(lead?.email);
  return email ? safeKey(["lead", "exit_popup", hashValue(email)]) : "";
};

export const buildBookingDedupeKey = (params) => {
  const bookingId = normalizeString(params?.booking_id);
  if (!bookingId) return "";
  return safeKey(["booking", hashValue(bookingId)]);
};
