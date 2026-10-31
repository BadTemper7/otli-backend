"use strict";

// Read-only administrative history for registration OTP activity.
// Store masked addresses only: no OTP, SMTP credential, message body, or raw email.
// Events start when this feature is deployed. Earlier quota reservations cannot
// be reliably reconstructed into provider acceptance or failure events.

const COLLECTION_NAME = "registration_email_events";
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_TYPES = Object.freeze([
  "reserved", "smtp_accepted", "smtp_rejected", "smtp_unconfirmed", "rate_limited",
]);
const FLOW_TYPES = Object.freeze(["request_otp", "resend_otp"]);
const SAFE_ERROR_CODES = new Set([
  "EAUTH", "ETIMEDOUT", "ECONNECTION", "ECONNRESET", "EENVELOPE",
  "ESOCKET", "EDNS", "SMTP_REJECTED", "SMTP_ERROR", "ECONNREFUSED",
  "ECONNABORTED", "EHOSTUNREACH", "ENOTFOUND",
]);

const getCollection = (collection) => collection || require("mongoose").connection.db.collection(COLLECTION_NAME);
const safeRecipientMask = (email) => {
  const raw = String(email || "").trim().toLowerCase();
  const parts = raw.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "—";
  const prefix = /^[a-z0-9]$/.test(parts[0][0]) ? parts[0][0] : "*";
  const labels = parts[1].split(".");
  const domainPrefix = /^[a-z0-9]$/.test(labels[0]?.[0] || "") ? labels[0][0] : "*";
  const suffix = labels.length > 1 && /^[a-z]{2,10}$/.test(labels.at(-1)) ? labels.at(-1) : "***";
  return `${prefix}***@${domainPrefix}***.${suffix}`;
};

const normalizedErrorCode = (code) => {
  const key = String(code || "SMTP_ERROR").toUpperCase();
  return SAFE_ERROR_CODES.has(key) ? key : "SMTP_ERROR";
};
const classifySmtpFailure = (error) => {
  // A definite SMTP rejection may be reported as a 5xx response. A timeout
  // or connection loss is *unconfirmed*, not proof that delivery failed.
  const responseCode = Number(error?.responseCode);
  if (responseCode >= 500 && responseCode < 600) return "smtp_rejected";
  if (error?.code === "SMTP_REJECTED") return "smtp_rejected";
  return "smtp_unconfirmed";
};

const recordRegistrationEmailEvent = async ({
  collection, eventType, flow = "request_otp", recipient, errorCode, now = () => Date.now(),
} = {}) => {
  if (!EVENT_TYPES.includes(eventType)) throw new Error("Invalid registration email event type.");
  if (!FLOW_TYPES.includes(flow)) throw new Error("Invalid registration email flow.");
  const timestamp = Number(now());
  if (!Number.isFinite(timestamp)) throw new Error("Invalid clock for email history.");
  const store = getCollection(collection);
  if (eventType === "rate_limited") {
    // Coalesce excessive blocked requests into a minute bucket to prevent an
    // abusive client from causing thousands of database inserts. Do not retain
    // a recipient or IP address for rate-limit events.
    const minute = Math.floor(timestamp / 60000) * 60000;
    return store.updateOne(
      { _id: `rate_limited:${flow}:${minute}` },
      {
        $setOnInsert: { eventType, flow, createdAt: new Date(minute) },
        $inc: { count: 1 },
      },
      { upsert: true },
    );
  }
  return store.insertOne({
    eventType,
    flow,
    recipientMasked: safeRecipientMask(recipient),
    ...(eventType === "smtp_rejected" || eventType === "smtp_unconfirmed"
      ? { errorCode: normalizedErrorCode(errorCode) } : {}),
    count: 1,
    createdAt: new Date(timestamp),
  });
};

const recordEmailEventSafely = (details) => {
  // History collection is best effort. Telemetry must never block a customer's
  // registration or change SMTP quota reservation behavior during an outage.
  void Promise.resolve()
    .then(() => recordRegistrationEmailEvent(details))
    .catch(() => console.warn("[email-monitoring] Could not record OTP activity."));
};

// Strict YYYY-MM-DD calendar dates, fixed Asia/Manila (+08:00) reporting days.
const parseDate = (date) => {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  if (y < 2000 || y > 2100) return null;
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) return null;
  return Date.UTC(y, m - 1, d) - MANILA_OFFSET_MS;
};
const manilaDate = (ms) => new Date(Number(ms) + MANILA_OFFSET_MS).toISOString().slice(0, 10);
const parseReportRange = ({ from, to, now = () => Date.now() } = {}) => {
  const today = manilaDate(now());
  const firstDate = from || today;
  const lastDate = to || firstDate;
  const start = parseDate(firstDate);
  const endStart = parseDate(lastDate);
  if (start === null || endStart === null || endStart < start || endStart - start >= 93 * DAY_MS) {
    const error = new Error("Choose valid dates in YYYY-MM-DD format (maximum 93 days per report).");
    error.statusCode = 400;
    throw error;
  }
  return {
    from: firstDate,
    to: lastDate,
    timezone: "Asia/Manila",
    start: new Date(start),
    endExclusive: new Date(endStart + DAY_MS),
  };
};
const parseHistoryOptions = (params = {}, opts = {}) => {
  const range = parseReportRange({ from: params.from, to: params.to, now: opts.now });
  const page = params.page === undefined ? 1 : Number(params.page);
  const limit = params.limit === undefined ? 25 : Number(params.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error("Invalid pagination: page 1–1000 and limit 1–100 are supported.");
    error.statusCode = 400;
    throw error;
  }
  if (params.type && !EVENT_TYPES.includes(params.type)) {
    const error = new Error("Invalid email event filter.");
    error.statusCode = 400;
    throw error;
  }
  return { ...range, page, limit, type: params.type || "all" };
};

const summarizeBuckets = (buckets) => {
  const summary = { attempted: 0, accepted: 0, rejected: 0, unconfirmed: 0, rateLimited: 0 };
  const dailyMap = new Map();
  const keys = {
    reserved: "attempted", smtp_accepted: "accepted", smtp_rejected: "rejected",
    smtp_unconfirmed: "unconfirmed", rate_limited: "rateLimited",
  };
  for (const row of buckets || []) {
    const type = row?._id?.eventType;
    const key = keys[type];
    const date = row?._id?.date;
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) continue;
    const count = Math.max(0, Number(row.count) || 0);
    summary[key] += count;
    if (!dailyMap.has(date)) dailyMap.set(date, { date, attempted: 0, accepted: 0, rejected: 0, unconfirmed: 0, rateLimited: 0 });
    dailyMap.get(date)[key] += count;
  }
  return { summary, daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)) };
};

const aggregatePipeline = (match) => [
  { $match: match },
  { $group: {
    _id: {
      date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Manila" } },
      eventType: "$eventType",
    },
    count: { $sum: { $ifNull: ["$count", 1] } },
  } },
];

const getEmailMonitoringReport = async ({ collection, params = {}, now } = {}) => {
  const options = parseHistoryOptions(params, { now });
  const store = getCollection(collection);
  const period = { createdAt: { $gte: options.start, $lt: options.endExclusive } };
  const historyFilter = options.type === "all" ? period : { ...period, eventType: options.type };
  const projection = { eventType: 1, flow: 1, recipientMasked: 1, errorCode: 1, count: 1, createdAt: 1 };
  const [buckets, totalRecords, rows] = await Promise.all([
    store.aggregate(aggregatePipeline(period)).toArray(),
    store.countDocuments(historyFilter),
    store.find(historyFilter, { projection })
      .sort({ createdAt: -1, _id: -1 })
      .skip((options.page - 1) * options.limit)
      .limit(options.limit)
      .toArray(),
  ]);
  const { summary, daily } = summarizeBuckets(buckets);
  return {
    channel: "registration_otp",
    source: "one_true_app_events",
    providerDeliveryVerified: false,
    historicalDataStartsAtDeployment: true,
    timezone: options.timezone,
    range: { from: options.from, to: options.to },
    summary,
    daily,
    history: {
      page: options.page, pageSize: options.limit, totalRecords,
      totalPages: Math.ceil(totalRecords / options.limit),
      rows: rows.map((item) => ({
        id: String(item._id),
        at: new Date(item.createdAt).toISOString(),
        eventType: item.eventType,
        flow: item.flow,
        recipientMasked: item.recipientMasked || null,
        errorCode: item.errorCode || null,
        count: item.count || 1,
      })),
    },
  };
};

const csvEscape = (value) => {
  let text = String(value == null ? "" : value);
  // Protect spreadsheet programs from formula injection (including future fields).
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
const manilaDateTime = (value) => new Date(new Date(value).getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 19) + "+08:00";
const csvRecord = (item) => [
  manilaDateTime(item.createdAt),
  item.eventType, item.flow, item.recipientMasked || "", item.count || 1, item.errorCode || "",
].map(csvEscape).join(",") + "\r\n";

module.exports = {
  COLLECTION_NAME, EVENT_TYPES, FLOW_TYPES,
  safeRecipientMask, classifySmtpFailure, normalizedErrorCode,
  recordRegistrationEmailEvent, recordEmailEventSafely,
  parseDate, manilaDate, parseReportRange, parseHistoryOptions,
  summarizeBuckets, aggregatePipeline, getEmailMonitoringReport,
  csvEscape, csvRecord, manilaDateTime, getCollection,
};
