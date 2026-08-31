import { describe, expect, it } from "vitest";
import {
  multipleChoiceChannels,
  validateExistingAttribute,
} from "../scripts/tracking-audit-brevo-options.mjs";

const definition = {
  name: "AUDIT_PAID_CHANNELS",
  type: "multiple-choice",
  multiCategoryOptions: multipleChoiceChannels,
};

describe("Tracking Audit Brevo attribute option validation", () => {
  it("accepts the exact canonical option set regardless of order", () => {
    const result = validateExistingAttribute(
      {
        name: "AUDIT_PAID_CHANNELS",
        category: "normal",
        type: "multiple-choice",
        multiCategoryOptions: [...multipleChoiceChannels].reverse(),
      },
      definition,
    );

    expect(result).toEqual({ ok: true });
  });

  it("rejects an existing option set with a missing canonical channel", () => {
    const result = validateExistingAttribute(
      {
        name: "AUDIT_PAID_CHANNELS",
        category: "normal",
        type: "multiple-choice",
        multiCategoryOptions: multipleChoiceChannels.filter((option) => option !== "microsoft_ads"),
      },
      definition,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.expected).toContain("microsoft_ads");
    expect(result.actual).not.toContain("microsoft_ads");
  });

  it("rejects an existing option set with a stale extra channel", () => {
    const result = validateExistingAttribute(
      {
        name: "AUDIT_PAID_CHANNELS",
        category: "normal",
        type: "multiple-choice",
        multiCategoryOptions: [...multipleChoiceChannels, "facebook_ads"],
      },
      definition,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.actual).toContain("facebook_ads");
  });

  it("rejects whitespace-corrupted options even when trimming would match", () => {
    const result = validateExistingAttribute(
      {
        name: "AUDIT_PAID_CHANNELS",
        category: "normal",
        type: "multiple-choice",
        multiCategoryOptions: multipleChoiceChannels.map((option) =>
          option === "meta_ads" ? "meta_ads " : option
        ),
      },
      definition,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.actual).toContain('\"meta_ads \"');
  });

  it("rejects duplicate options even when deduplication would match", () => {
    const result = validateExistingAttribute(
      {
        name: "AUDIT_PAID_CHANNELS",
        category: "normal",
        type: "multiple-choice",
        multiCategoryOptions: [...multipleChoiceChannels, "meta_ads"],
      },
      definition,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects non-string option entries", () => {
    const result = validateExistingAttribute(
      {
        name: "AUDIT_PAID_CHANNELS",
        category: "normal",
        type: "multiple-choice",
        multiCategoryOptions: [...multipleChoiceChannels.slice(0, -1), 42],
      },
      definition,
    );

    expect(result.ok).toBe(false);
  });

  it("still rejects category or type conflicts before option validation", () => {
    const result = validateExistingAttribute(
      {
        name: "AUDIT_PAID_CHANNELS",
        category: "category",
        type: "text",
        multiCategoryOptions: multipleChoiceChannels,
      },
      definition,
    );

    expect(result).toEqual({
      ok: false,
      expected: "normal/multiple-choice",
      actual: "category/text",
    });
  });
});
