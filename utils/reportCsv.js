"use strict";

// Prefix untrusted spreadsheet-formula text. This includes whitespace-prefixed
// formulas, which Excel and other spreadsheet clients may still execute.
const csvCell = (value) => {
  const text = String(value ?? "");
  const safe = typeof value === "string" && /^[\s\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};
const csvLine = (cells) => `${cells.map(csvCell).join(",")}\r\n`;
module.exports = { csvCell, csvLine };
