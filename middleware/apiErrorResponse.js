"use strict";

const isMongoConnectivityError = (error) => {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (/^(MongoServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError|MongoPoolClearedError|MongoWaitQueueTimeoutError|MongoTopologyClosedError|MongoNotConnectedError)$/.test(name)) {
    return true;
  }
  if (name === "MongoServerError" && (code === "50" || code === "91" || code === "11600" || code === "11602")) return true;
  if (name === "MongooseError" && /buffering timed out|connection.*(closed|lost|not open)|server selection/i.test(message)) return true;
  return false;
};

const createApiErrorHandler = ({ logger = console } = {}) => (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const dbUnavailable = isMongoConnectivityError(error);
  const uploadTooLarge = error?.name === "MulterError" && error?.code === "LIMIT_FILE_SIZE";
  const uploadInvalid = error?.name === "MulterError" && !uploadTooLarge;
  const rawStatus = Number(error?.statusCode || error?.status || 500);
  const suppliedStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const status = dbUnavailable ? 503 : uploadTooLarge ? 413 : uploadInvalid ? 400 : suppliedStatus;
  const code = dbUnavailable ? "DATABASE_UNAVAILABLE" : uploadTooLarge ? "UPLOAD_TOO_LARGE" : uploadInvalid ? "INVALID_UPLOAD" : undefined;
  const publicMessage = dbUnavailable
    ? "Database temporarily unavailable. Please try again shortly."
    : uploadTooLarge ? "One of your uploaded files is too large."
    : uploadInvalid ? "The uploaded files do not meet the upload requirements."
    : status >= 500 ? "Something went wrong. Please try again later."
    : error?.message || "Request could not be completed.";

  if (dbUnavailable) res.setHeader("Retry-After", "5");
  // Safe metadata only; error.message/stack could contain SMTP or MongoDB secrets.
  if (status >= 500) {
    logger.error(`[api] error id=${req.apiRequestId || "untracked"} type=${String(error?.name || "Error").slice(0, 80)} status=${status}`);
  }
  // Keep the existing top-level `error` and `message` response fields so
  // older clients checking `error` do not break after the safety update.
  return res.status(status).json({
    success: false,
    error: "Something went wrong!",
    ...(code ? { code } : {}),
    message: publicMessage,
  });
};

module.exports = { isMongoConnectivityError, createApiErrorHandler };
