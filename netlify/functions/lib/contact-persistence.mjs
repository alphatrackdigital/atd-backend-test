import mongoose from "mongoose";

const ContactSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["contact_form", "tracking_audit_offer"], required: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    company: { type: String, trim: true, default: "" },
    message: { type: String, default: "" },
    websiteUrl: { type: String, default: "" },
    monthlyAdSpend: { type: String, default: "" },
    adPlatforms: { type: String, default: "" },
    serviceInterest: { type: String, default: "" },
    monthlyBudget: { type: String, default: "" },
    ip: { type: String, default: "" },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const Contact = mongoose.models.Contact || mongoose.model("Contact", ContactSchema);

export const buildContactDocument = (payload, ip) => ({
  source: payload.source,
  firstName: payload.firstName || "",
  lastName: payload.lastName || "",
  email: payload.email,
  company: payload.company || "",
  message: payload.message || "",
  websiteUrl: payload.websiteUrl || "",
  monthlyAdSpend: payload.monthlyAdSpend || "",
  adPlatforms: payload.adPlatforms || "",
  serviceInterest: Array.isArray(payload.serviceInterest)
    ? payload.serviceInterest.join(", ")
    : "",
  monthlyBudget: payload.monthlyBudget || "",
  ip,
});

export const saveLeadContact = async (payload, ip, mongoUri, databaseName = "alphatrack") => {
  if (!mongoUri || payload.source === "newsletter") return false;

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri, { dbName: databaseName });
  }

  await Contact.create(buildContactDocument(payload, ip));

  return true;
};
