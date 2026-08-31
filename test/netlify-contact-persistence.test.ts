import { describe, expect, it } from "vitest";
import { buildContactDocument } from "../netlify/functions/lib/contact-persistence.mjs";

describe("Netlify lead persistence mapping", () => {
  it("preserves admin fields and converts Brevo's service array for Mongo", () => {
    expect(buildContactDocument({
      source: "contact_form",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      company: "Analytical Engines",
      message: "Please call",
      serviceInterest: ["Analytics", "Automation"],
      monthlyBudget: "3",
    }, "203.0.113.10")).toEqual({
      source: "contact_form",
      submissionKey: "",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      company: "Analytical Engines",
      message: "Please call",
      websiteUrl: "",
      monthlyAdSpend: "",
      adPlatforms: "",
      serviceInterest: "Analytics, Automation",
      monthlyBudget: "3",
      ip: "203.0.113.10",
    });
  });
});
