import mongoose, { Schema, Document, Model } from "mongoose";

export interface IContact extends Document {
  source: "contact_form" | "tracking_audit_offer";
  submissionKey?: string;
  firstName: string;
  lastName: string;
  email: string;
  company?: string;
  message?: string;
  websiteUrl?: string;
  monthlyAdSpend?: string;
  legacyMonthlyAdSpend?: string;
  monthlyAdSpendBand?: string;
  adPlatforms?: string;
  industry?: string;
  role?: string;
  decisionInfluence?: string;
  trackingMaturity?: string;
  primaryConversionType?: string;
  measurementProblem?: string;
  urgency?: string;
  serviceInterest?: string;
  monthlyBudget?: string;
  ip?: string;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ContactSchema = new Schema<IContact>(
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

export const Contact: Model<IContact> =
  mongoose.models.Contact || mongoose.model<IContact>("Contact", ContactSchema);
