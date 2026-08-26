import { createHash } from "node:crypto";

const memoryStore = globalThis.__atdConversionIdempotency ?? new Map();
globalThis.__atdConversionIdempotency = memoryStore;

const STORE_NAME = "atd-conversion-idempotency";
let testDurableStore;

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

export const resetIdempotencyForTests = () => {
  if (process.env.VITEST) {
    memoryStore.clear();
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
