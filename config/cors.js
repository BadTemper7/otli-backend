"use strict";

// Use the same exact-origin allowlist for Express and Socket.IO. No additional
// environment variables are needed: CLIENT_ORIGINS is already configured.
// Defaults are only used when CLIENT_ORIGINS is absent.
const DEFAULT_CLIENT_ORIGINS = Object.freeze([
  "https://onetrue.ph",
  "https://admin.onetrue.ph",
]);

const normalizeOrigin = (candidate) => {
  if (typeof candidate !== "string" || !candidate.trim()) return null;

  try {
    const parsed = new URL(candidate.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    // Do not accept a mistyped domain as a URL with a path, an embedded
    // credential, or an accidental query/fragment.
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const getAllowedOrigins = (value = process.env.CLIENT_ORIGINS) => {
  const raw = typeof value === "string" && value.trim()
    ? value
    : DEFAULT_CLIENT_ORIGINS.join(",");

  return [...new Set(raw.split(",").map(normalizeOrigin).filter(Boolean))];
};

const isAllowedOrigin = (origin, allowedOrigins) => {
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && allowedOrigins.includes(normalized));
};

const createCorsOptions = (allowedOrigins) => ({
  // Origin-less requests (mobile apps, health checks, curl) still work.
  // Browser-originated requests must match the allowlist exactly.
  origin: (origin, callback) => {
    callback(null, !origin || isAllowedOrigin(origin, allowedOrigins));
  },
  // Required if an existing frontend uses credentials: 'include' / withCredentials.
  // An exact origin is reflected; never send '*' with this flag.
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Leave allowedHeaders unspecified so the CORS middleware can echo the
  // requested Authorization / Content-Type / other existing client headers.
  optionsSuccessStatus: 204,
  maxAge: 600,
});

module.exports = {
  DEFAULT_CLIENT_ORIGINS,
  normalizeOrigin,
  getAllowedOrigins,
  isAllowedOrigin,
  createCorsOptions,
};
