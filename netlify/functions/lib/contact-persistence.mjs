import mongoose from "mongoose";

const ContactSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["contact_form", "tracking_audit_offer"], required: true },
    submissionKey: { type: String, trim: true, default: "", index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    company: { type: String, trim: true, default: "" },
    message: { type: String, default: "" },
    websiteUrl: { type: String, default: "" },
    monthlyAdSpend: { type: String, default: "" },
    legacyMonthlyAdSpend: { type: String, default: "" },
    monthlyAdSpendBand: { type: String, default: "" },
    adPlatforms: { type: String, default: "" },
    industry: { type: String, default: "" },
    role: { type: String, default: "" },
    decisionInfluence: { type: String, default: "" },
    trackingMaturity: { type: String, default: "" },
    primaryConversionType: { type: String, default: "" },
    measurementProblem: { type: String, default: "" },
    urgency: { type: String, default: "" },
    serviceInterest: { type: String, default: "" },
    monthlyBudget: { type: String, default: "" },
    ip: { type: String, default: "" },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const Contact = mongoose.models.Contact || mongoose.model("Contact", ContactSchema);

const toStoredList = (value) =>
  Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).join(", ")
    : typeof value === "string"
      ? value.trim()
      : "";

export const buildContactDocument = (payload, ip) => ({
  source: payload.source,
  submissionKey: payload.submissionKey || "",
  firstName: payload.firstName || "",
  lastName: payload.lastName || "",
  email: payload.email,
  company: payload.company || "",
  message: payload.message || "",
  websiteUrl: payload.websiteUrl || "",
  monthlyAdSpend: payload.monthlyAdSpend || "",
  adPlatforms: toStoredList(payload.adPlatforms),
  serviceInterest: toStoredList(payload.serviceInterest),
  monthlyBudget: payload.monthlyBudget || "",
  ...(payload.source === "tracking_audit_offer"
    ? {
        legacyMonthlyAdSpend: payload.legacyMonthlyAdSpend || "",
        monthlyAdSpendBand: payload.monthlyAdSpendBand || "",
        industry: payload.industry || "",
        role: payload.role || "",
        decisionInfluence: payload.decisionInfluence || "",
        trackingMaturity: payload.trackingMaturity || "",
        primaryConversionType: payload.primaryConversionType || "",
        measurementProblem: payload.measurementProblem || "",
        urgency: payload.urgency || "",
      }
    : {}),
  ip,
});

export const saveLeadContact = async (payload, ip, mongoUri, databaseName = "alphatrack") => {
  if (!mongoUri || payload.source === "newsletter") return false;
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri, { dbName: databaseName });
  }

  const document = buildContactDocument(payload, ip);
  if (payload.source === "tracking_audit_offer" && payload.submissionKey) {
    await Contact.updateOne(
      { source: "tracking_audit_offer", submissionKey: payload.submissionKey },
      { $setOnInsert: document },
      { upsert: true },
    );
    return true;
  }

  await Contact.create(document);
  return true;
};
