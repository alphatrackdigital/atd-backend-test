import { createHash } from "node:crypto";
import mongoose from "mongoose";

const memoryStore = globalThis.__atdConversionIdempotency ?? new Map();
globalThis.__atdConversionIdempotency = memoryStore;
const testAuditStepClaims = globalThis.__atdAuditStepClaims ?? new Map();
globalThis.__atdAuditStepClaims = testAuditStepClaims;

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

export const hashValue = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

const dayStamp = (date = new Date()) => date.toISOString().slice(0, 10);

const safeKey = (parts) => parts.map((part) => String(part).replace(/[^a-zA-Z0-9._-]/g, "-")).join("/");

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

export const claimAuditStep = async (key, { mongoUri, databaseName = "alphatrack", leaseMs = 60_000 } = {}) => {
  if (!key) return false;
  const nowMs = Date.now();

  if (process.env.VITEST) {
    const existing = testAuditStepClaims.get(key);
    if (existing?.status === "completed") return false;
    if (existing?.status === "in_progress" && (existing.leaseUntil || 0) > nowMs) return false;
    testAuditStepClaims.set(key, { status: "in_progress", leaseUntil: nowMs + leaseMs });
    return true;
  }

  await connectAuditStepStore(mongoUri, databaseName);
  const now = new Date(nowMs);
  const leaseUntil = new Date(nowMs + leaseMs);
  const expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000);

  try {
    await AuditStepClaim.create({ key, status: "in_progress", leaseUntil, createdAt: now, updatedAt: now, expiresAt });
    return true;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const reclaimed = await AuditStepClaim.findOneAndUpdate(
    { key, status: "in_progress", leaseUntil: { $lte: now } },
    { $set: { leaseUntil, updatedAt: now, expiresAt } },
    { new: true },
  ).lean();
  return Boolean(reclaimed);
};

export const completeAuditStep = async (key, { mongoUri, databaseName = "alphatrack" } = {}) => {
  if (!key) return;
  if (process.env.VITEST) {
    testAuditStepClaims.set(key, { status: "completed" });
    return;
  }

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
};

export const releaseAuditStep = async (key, { mongoUri, databaseName = "alphatrack" } = {}) => {
  if (!key) return;
  if (process.env.VITEST) {
    const existing = testAuditStepClaims.get(key);
    if (existing?.status === "in_progress") testAuditStepClaims.delete(key);
    return;
  }

  await connectAuditStepStore(mongoUri, databaseName);
  await AuditStepClaim.deleteOne({ key, status: "in_progress" });
};

export const resetIdempotencyForTests = () => {
  if (process.env.VITEST) {
    memoryStore.clear();
    testAuditStepClaims.clear();
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
    const website = normalizeString(payload?.websiteUrl);
    return safeKey(["lead", source, dayStamp(), hashValue(`${email}|${website}`)]);
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
