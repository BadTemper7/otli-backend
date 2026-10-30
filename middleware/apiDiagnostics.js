"use strict";

// Lightweight request diagnostics shared by every API route.
// Logs method + registered route pattern only, never query strings, bodies,
// authorization headers, client emails, OTPs or document names.
const { randomUUID } = require("node:crypto");

const elapsedMs = (started) => Math.round(Number(process.hrtime.bigint() - started) / 1e6);
const databaseState = (state) => ({ 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" })[state] || "unknown";

const safeRouteLabel = (req) => {
  const route = req.route?.path;
  if (typeof route === "string") return `${req.baseUrl || ""}${route}` || "/";
  // Do not log actual route parameters (booking number, email address, etc.).
  return "(unmatched-api-route)";
};

const createApiDiagnostics = ({ getDatabaseState = () => undefined, logger = console, slowMs = 3000 } = {}) =>
  (req, res, next) => {
    const started = process.hrtime.bigint();
    const requestId = randomUUID();
    req.apiRequestId = requestId;
    res.setHeader("X-Request-ID", requestId);

    let logged = false;
    const record = (disconnected) => {
      if (logged) return;
      logged = true;
      const duration = elapsedMs(started);
      if (!disconnected && duration < slowMs && res.statusCode < 500) return;
      const details = `id=${requestId} method=${req.method} route=${safeRouteLabel(req)} ` +
        `status=${res.statusCode} totalMs=${duration} db=${databaseState(getDatabaseState())}`;
      if (disconnected) logger.warn(`[api] client/proxy disconnected ${details}`);
      else if (res.statusCode >= 500) logger.warn(`[api] server error ${details}`);
      else logger.info(`[api] slow request ${details}`);
    };

    res.once("finish", () => record(false));
    res.once("close", () => {
      if (!res.writableEnded) record(true);
    });
    next();
  };

module.exports = { createApiDiagnostics, databaseState, safeRouteLabel };
