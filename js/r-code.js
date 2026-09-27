// Writing R code from JavaScript values: every string the engine worker puts
// into R code goes through here, quoted and escaped, so text from an
// interface spec or a file name can only ever be data.

export const rString = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export const rNumber = (value) => (value === undefined || value === null || Number.isNaN(Number(value)) ? "NULL" : Number(value));

// Widget values as R literals. Names come from the spec parser, which only
// accepts R-safe identifiers, so this can't smuggle in code.
export const rLiteral = (value) => {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NA";
  return rString(value);
};

export const rList = (values) =>
  `list(${Object.entries(values).map(([name, value]) => `${name} = ${rLiteral(value)}`).join(", ")})`;

// Plain data (from the spec parser) as an R expression: null → NULL, whole
// numbers → integers, arrays of strings → character vectors, other arrays →
// unnamed lists, objects → named lists. Object keys are field names the
// Workbench itself chose, never user text.
export const rValue = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return rString(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NA";
    return Number.isInteger(value) ? `${value}L` : String(value);
  }
  if (Array.isArray(value)) {
    return value.length && value.every((item) => typeof item === "string")
      ? `c(${value.map(rString).join(", ")})`
      : `list(${value.map(rValue).join(", ")})`;
  }
  return `list(${Object.entries(value).map(([key, item]) => `${key} = ${rValue(item)}`).join(", ")})`;
};

// A file name that's safe as the last part of a path in R's filesystem.
export const safeFileName = (name) =>
  String(name).replace(/[\/\\]/g, "_").replace(/[\u0000-\u001f]/g, "").replace(/^\.+$/, "") || "file";
