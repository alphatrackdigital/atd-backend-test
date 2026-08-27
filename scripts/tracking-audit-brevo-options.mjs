export const multipleChoiceChannels = Object.freeze([
  "meta_ads",
  "google_ads",
  "microsoft_ads",
  "linkedin_ads",
  "tiktok_ads",
  "other",
  "none_currently",
]);

const rawOptionsMatchIgnoringOrder = (actual, expected) => {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length) return false;
  if (!actual.every((item) => typeof item === "string")) return false;
  if (!expected.every((item) => typeof item === "string")) return false;

  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedExpected.every((option, index) => option === sortedActual[index]);
};

const describeOptions = (value) =>
  Array.isArray(value)
    ? value.map((item) => JSON.stringify(item)).join(", ")
    : "(not an array)";

export const validateExistingAttribute = (current, definition) => {
  const expectedType = `normal/${definition.type}`;
  const actualType = `${current?.category || "unknown"}/${current?.type || "unknown"}`;

  if (current?.category !== "normal" || current?.type !== definition.type) {
    return { ok: false, expected: expectedType, actual: actualType };
  }

  if (definition.multiCategoryOptions) {
    const expectedOptions = definition.multiCategoryOptions;
    const actualOptions = current.multiCategoryOptions;

    if (!rawOptionsMatchIgnoringOrder(actualOptions, expectedOptions)) {
      return {
        ok: false,
        expected: `${expectedType} options=[${describeOptions(expectedOptions)}]`,
        actual: `${actualType} options=[${describeOptions(actualOptions)}]`,
      };
    }
  }

  return { ok: true };
};
