"use strict";

// Express and Socket.IO must use the same CORS rules. The browser enforces
// CORS; this policy controls which origins the server approves.
const DEFAULT_PRODUCTION_ORIGINS = [
  "https://onetrue.ph",
  "https://admin.onetrue.ph",
];

function parseOrigin(origin) {
  if (typeof origin !== "string" || !origin.trim()) return null;
  try {
    const url = new URL(origin.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((value) => parseOrigin(value))
    .filter(Boolean);
}

function createCorsPolicy(env = process.env) {
  // Fail closed if NODE_ENV is missing/misspelled on a hosted deployment.
  const isDevelopment = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  const allowedOrigins = new Set([
    ...DEFAULT_PRODUCTION_ORIGINS,
    ...splitOrigins(env.CLIENT_ORIGINS),
    ...splitOrigins(env.CORS_ORIGINS),
    ...splitOrigins(env.SOCKET_ALLOWED_ORIGINS),
  ]);

  function isAllowedOrigin(origin) {
    // Browser-independent tools and same-origin calls don't send Origin.
    if (origin === undefined || origin === null || origin === "") return true;

    // Local development is deliberately permissive, including arbitrary
    // Vite ports. Do not enable this policy on production deployments.
    if (isDevelopment) return true;

    const normalized = parseOrigin(origin);
    return normalized !== null && allowedOrigins.has(normalized);
  }

  const corsOptions = {
    origin(origin, callback) {
      // Reflect approved Origin, never send '*' with credentials.
      callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    optionsSuccessStatus: 204,
    maxAge: 600,
    exposedHeaders: ["X-Request-ID", "Retry-After"],
  };

  return { corsOptions, isAllowedOrigin, isDevelopment };
}

module.exports = { createCorsPolicy };
