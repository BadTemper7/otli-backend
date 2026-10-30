"use strict";

// When Atlas is disconnected, fail quickly and clearly instead of letting
// Mongoose buffer API operations and the browser eventually time out.
const createDatabaseAvailability = (getDatabaseState) => (req, res, next) => {
  // The lightweight /api/test endpoint is intentionally independent of MongoDB.
  if (req.path === "/test") return next();
  if (getDatabaseState() === 1) return next();
  res.setHeader("Retry-After", "5");
  return res.status(503).json({
    success: false,
    code: "DATABASE_UNAVAILABLE",
    message: "The service is temporarily unavailable. Please try again shortly.",
  });
};

module.exports = { createDatabaseAvailability };
