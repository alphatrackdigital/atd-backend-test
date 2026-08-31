#!/usr/bin/env node

import { multipleChoiceChannels, validateExistingAttribute } from "./tracking-audit-brevo-options.mjs";

const API_BASE = "https://api.brevo.com/v3";
const apiKey = process.env.BREVO_API_KEY?.trim();

if (!apiKey) {
  console.error("BREVO_API_KEY is required. The value is never printed by this script.");
  process.exit(1);
}

const requiredAttributes = [
  { name: "WEBSITE_URL", type: "text" },
  { name: "AUDIT_INDUSTRY", type: "text" },
  { name: "AUDIT_ROLE", type: "text" },
  { name: "AUDIT_DECISION_INFLUENCE", type: "text" },
  { name: "AUDIT_AD_SPEND_BAND", type: "text" },
  { name: "AUDIT_LEGACY_AD_SPEND", type: "text" },
  { name: "AUDIT_PAID_CHANNELS", type: "multiple-choice", multiCategoryOptions: multipleChoiceChannels },
  { name: "AUDIT_TRACKING_MATURITY", type: "text" },
  { name: "AUDIT_PRIMARY_CONVERSION", type: "text" },
  { name: "AUDIT_MEASUREMENT_PROBLEM", type: "text" },
  { name: "AUDIT_URGENCY", type: "text" },
  { name: "AUDIT_STATUS", type: "text" },
  { name: "AUDIT_HANDOFF_STATUS", type: "text" },
  { name: "AUDIT_REVIEW_OUTCOME", type: "text" },
  { name: "AUDIT_REVIEW_RATIONALE", type: "text" },
  { name: "AUDIT_REVIEWER", type: "text" },
  { name: "AUDIT_APPLIED_AT", type: "text" },
  { name: "AUDIT_REVIEWED_AT", type: "text" },
  { name: "AUDIT_ACCEPTED_AT", type: "text" },
  { name: "AUDIT_SCORECARD_DELIVERED_AT", type: "text" },
  { name: "AUDIT_CLOSED_AT", type: "text" },
  { name: "AUDIT_OPPORTUNITY_AT", type: "text" },
];

const request = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "api-key": apiKey,
      ...(options.headers || {}),
    },
  });
  return response;
};

const listResponse = await request("/contacts/attributes", { method: "GET" });
if (!listResponse.ok) {
  console.error(`Unable to list Brevo contact attributes (HTTP ${listResponse.status}).`);
  process.exit(1);
}

const listed = await listResponse.json();
const existing = new Map(
  (listed.attributes || [])
    .filter((attribute) => attribute?.name)
    .map((attribute) => [attribute.name, attribute]),
);

const created = [];
const verified = [];
const conflicts = [];

for (const definition of requiredAttributes) {
  const current = existing.get(definition.name);
  if (current) {
    const validation = validateExistingAttribute(current, definition);
    if (!validation.ok) {
      conflicts.push({
        name: definition.name,
        expected: validation.expected,
        actual: validation.actual,
      });
      continue;
    }
    verified.push(definition.name);
    continue;
  }

  const body = {
    type: definition.type,
    ...(definition.multiCategoryOptions
      ? { multiCategoryOptions: definition.multiCategoryOptions }
      : {}),
  };

  const createResponse = await request(
    `/contacts/attributes/normal/${encodeURIComponent(definition.name)}`,
    { method: "POST", body: JSON.stringify(body) },
  );

  if (!createResponse.ok) {
    const safeError = await createResponse.text().catch(() => "");
    console.error(
      `Failed to create ${definition.name} (HTTP ${createResponse.status}). ${safeError.slice(0, 180)}`,
    );
    process.exit(1);
  }

  created.push(definition.name);
}

if (conflicts.length) {
  console.error("Brevo attribute type conflicts detected. No existing attribute was changed:");
  for (const conflict of conflicts) {
    console.error(`- ${conflict.name}: expected ${conflict.expected}; found ${conflict.actual}`);
  }
  process.exit(2);
}

console.log(`Brevo Tracking Audit attributes verified: ${verified.length}`);
console.log(`Brevo Tracking Audit attributes created: ${created.length}`);
if (created.length) console.log(`Created: ${created.join(", ")}`);
console.log("No existing attribute types were modified. BREVO_API_KEY was not printed.");
