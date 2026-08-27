export const multipleChoiceChannels = Object.freeze([
  "meta_ads",
  "google_ads",
  "microsoft_ads",
  "linkedin_ads",
  "tiktok_ads",
  "other",
  "none_currently",
]);

const normalizeOptions = (value) =>
  Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))].sort()
    : [];

export const validateExistingAttribute = (current, definition) => {
  const expectedType = `normal/${definition.type}`;
  const actualType = `${current?.category || "unknown"}/${current?.type || "unknown"}`;

  if (current?.category !== "normal" || current?.type !== definition.type) {
    return { ok: false, expected: expectedType, actual: actualType };
  }

  if (definition.multiCategoryOptions) {
    const expectedOptions = normalizeOptions(definition.multiCategoryOptions);
    const actualOptions = normalizeOptions(current.multiCategoryOptions);
    const optionsMatch =
      expectedOptions.length === actualOptions.length &&
      expectedOptions.every((option, index) => option === actualOptions[index]);

    if (!optionsMatch) {
      return {
        ok: false,
        expected: `${expectedType} options=[${expectedOptions.join(", ")}]`,
        actual: `${actualType} options=[${actualOptions.join(", ")}]`,
      };
    }
  }

  return { ok: true };
};
